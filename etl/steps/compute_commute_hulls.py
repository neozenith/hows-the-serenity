"""Compute commute-tier hulls per PTV mode from the primary cached dataset.

Replaces the predecessor pipeline's metro-clipped hulls with a whole-network
computation that supports multiple hull centres (Southern Cross plus the
regional hubs). The primary data is:

- ``public_transport_stops.parquet`` — every PTV stop, statewide, with MODE
- ``public_transport_lines.parquet`` — route shape geometries per MODE
- ``transit_time_cache/*.json``       — Google Maps transit minutes from each
  stop to Southern Cross Station (one scalar per stop name)

The trick: on a radial network, the travel time between two adjacent stops on
the same line is recoverable from the cached scalars as ``|t(A) - t(B)|``
where ``t`` is the cached minutes-to-Southern-Cross. Snapping each mode's
stops onto each route shape and ordering them along the shape yields the
adjacency; the absolute time difference becomes the edge weight. Dijkstra
over that per-mode graph then gives minutes-from-centre for any centre node,
so hulls can radiate from Geelong or Bendigo — not just Southern Cross.

For the Southern Cross centre the cached scalars *are* the distance field
(they include real-world waits and transfers), so they are used directly
instead of the derived graph — primary measurements beat derived ones.

Each mode stays a separate network: tram, metro train and regional train
graphs never share edges, matching the three separate hull layers.
"""

from __future__ import annotations

import heapq
import itertools
import json
import logging
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import LineString, Point
from shapely.ops import substring, unary_union

log = logging.getLogger("etl.steps.compute_commute_hulls")

# Snap tolerances, in EPSG:4326 degrees (~111 km per degree of latitude).
STOP_TO_LINE_TOLERANCE_DEG = 0.001  # ~110 m: stop counts as "on" a route shape
TRANSFER_TOLERANCE_DEG = 0.002  # ~220 m: same-station nodes join for free
CENTRE_SNAP_TOLERANCE_DEG = 0.01  # ~1.1 km: centre must be this close to a node
# Buffer applied to member stops before hulling so sparse/collinear tiers
# (e.g. 15 min around Shepparton, a handful of stops along one track) still
# produce a visible polygon instead of a degenerate sliver.
HULL_POINT_BUFFER_DEG = 0.003  # ~330 m
CONCAVE_HULL_RATIO = 0.6  # matches the predecessor pipeline's hulls


@dataclass(frozen=True)
class Centre:
    """A hull centre. ``direct_times`` marks the centre whose distance field
    is exactly the cached minutes-to-Southern-Cross (i.e. Southern Cross)."""

    slug: str
    name: str
    lon: float
    lat: float
    direct_times: bool = False


def _cache_path(cache_dir: Path, stop_name: str) -> Path:
    """Cache filename convention from the upstream isochrones project."""
    slug = stop_name.lower().replace(" ", "_").replace(",", "").replace("'", "")
    return cache_dir / f"{slug}_transit_time.json"


def _load_cached_minutes(cache_dir: Path, stop_name: str) -> float | None:
    path = _cache_path(cache_dir, stop_name)
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        log.warning("Unparseable cache file: %s", path)
        return None
    minutes = record.get("transit_time_minutes")
    return float(minutes) if minutes is not None else None


def load_stop_nodes(
    stops_parquet: Path,
    cache_dir: Path,
    mode_label: str,
    *,
    exclude_stop_pattern: str | None = None,
) -> pd.DataFrame:
    """One node per unique STOP_NAME for the mode, with cached minutes-to-SCS.

    Multiple platform rows collapse to the first point; stops without a cache
    entry are dropped (they carry no time signal so can't anchor an edge).
    ``exclude_stop_pattern`` removes rail-replacement bus stops and wayfinding
    markers, which are tagged with the rail mode but are not stations.
    """
    stops = gpd.read_parquet(stops_parquet)
    stops = stops[stops["MODE"] == mode_label]
    if stops.empty:
        raise ValueError(f"No stops found for MODE={mode_label!r} in {stops_parquet}")

    if exclude_stop_pattern:
        drop = (
            stops["STOP_NAME"]
            .astype(str)
            .str.contains(exclude_stop_pattern, case=False, regex=True, na=False)
        )
        if drop.any():
            log.info(
                "%s: dropping %d non-station stops (replacement buses, wayfinding markers)",
                mode_label,
                int(drop.sum()),
            )
        stops = stops[~drop]
        if stops.empty:
            raise ValueError(f"All stops filtered out for MODE={mode_label!r}")

    records: list[dict[str, object]] = []
    for name, group in stops.groupby("STOP_NAME"):
        minutes = _load_cached_minutes(cache_dir, str(name))
        if minutes is None:
            continue
        geom = group.geometry.iloc[0]
        records.append({"name": str(name), "minutes": minutes, "x": geom.x, "y": geom.y})
    nodes = pd.DataFrame.from_records(records)
    log.info(
        "%s: %d stop rows -> %d named nodes with cached times",
        mode_label,
        len(stops),
        len(nodes),
    )
    if nodes.empty:
        raise ValueError(f"No cached transit times matched MODE={mode_label!r}")
    return nodes


def _iter_adjacent_along_shapes(
    lines_parquet: Path,
    nodes: pd.DataFrame,
    mode_label: str,
    exclude_line_pattern: str | None = None,
) -> Iterator[tuple[int, int, LineString, float, float]]:
    """Yield (a, b, shape, dist_a, dist_b) for stops adjacent along a shape.

    Single source of the snap-and-order logic, so edge weights and the edge
    geometries drawn in review renders can never disagree about which stops
    are adjacent or where they sit along the track.

    ``exclude_line_pattern`` drops rail-replacement bus shapes. They are
    tagged with the rail mode but routed over roads, so stations snap onto
    them in road order and produce adjacency the railway does not have.
    """
    columns = ["MODE", "geometry"]
    if exclude_line_pattern:
        columns.append("SHORT_NAME")
    lines = gpd.read_parquet(lines_parquet, columns=columns)
    lines = lines[lines["MODE"] == mode_label]
    if lines.empty:
        raise ValueError(f"No line shapes found for MODE={mode_label!r} in {lines_parquet}")

    if exclude_line_pattern:
        drop = (
            lines["SHORT_NAME"]
            .astype(str)
            .str.contains(exclude_line_pattern, case=False, regex=True, na=False)
        )
        if drop.any():
            log.info(
                "%s: dropping %d replacement-bus shapes of %d",
                mode_label,
                int(drop.sum()),
                len(lines),
            )
        lines = lines[~drop]
        if lines.empty:
            raise ValueError(f"All line shapes filtered out for MODE={mode_label!r}")

    points = [Point(xy) for xy in zip(nodes["x"], nodes["y"], strict=True)]
    tree = shapely.STRtree(points)

    for geom in lines.geometry:
        parts = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
        for part in parts:
            idx = tree.query(part, predicate="dwithin", distance=STOP_TO_LINE_TOLERANCE_DEG)
            if len(idx) < 2:
                continue
            # Order the snapped stops by their position along the shape.
            projected = {int(i): float(part.project(points[i])) for i in idx}
            chain = sorted(projected, key=lambda i: projected[i])
            for a, b in itertools.pairwise(chain):
                yield a, b, part, projected[a], projected[b]


def build_edges(
    lines_parquet: Path,
    nodes: pd.DataFrame,
    mode_label: str,
    exclude_line_pattern: str | None = None,
) -> dict[tuple[int, int], float]:
    """Edges between stops adjacent along any route shape of the mode.

    Weight = |minutes(A) - minutes(B)| — the telescoped point-to-point travel
    time along the line, extracted from the cached radial scalars.
    """
    minutes = nodes["minutes"].to_numpy()
    edges: dict[tuple[int, int], float] = {}
    for a, b, _part, _da, _db in _iter_adjacent_along_shapes(
        lines_parquet, nodes, mode_label, exclude_line_pattern
    ):
        key = (a, b) if a < b else (b, a)
        weight = abs(float(minutes[a] - minutes[b]))
        prev = edges.get(key)
        if prev is None or weight < prev:
            edges[key] = weight
    log.info("%s: %d unique adjacency edges", mode_label, len(edges))
    return edges


def build_edge_paths(
    lines_parquet: Path,
    nodes: pd.DataFrame,
    mode_label: str,
    exclude_line_pattern: str | None = None,
) -> dict[tuple[int, int], LineString]:
    """Track geometry for each adjacency edge, for drawing the network.

    Each edge gets the substring of the route shape actually running between
    the two stops, so a rendered graph follows the rails rather than cutting
    straight chords across the landscape — which on regional lines, where
    stations are tens of kilometres apart, is a very different picture.
    """
    paths: dict[tuple[int, int], LineString] = {}
    for a, b, part, da, db in _iter_adjacent_along_shapes(
        lines_parquet, nodes, mode_label, exclude_line_pattern
    ):
        key = (a, b) if a < b else (b, a)
        segment = substring(part, min(da, db), max(da, db))
        # Keep the shortest candidate: express and stopping patterns share
        # stop pairs, and the shortest run is the one that hugs the track.
        prev = paths.get(key)
        if prev is None or segment.length < prev.length:
            paths[key] = segment
    return paths


def add_transfer_edges(
    nodes: pd.DataFrame, edges: dict[tuple[int, int], float]
) -> dict[tuple[int, int], float]:
    """Zero-weight edges between co-located nodes (same station, alt names)."""
    points = [Point(xy) for xy in zip(nodes["x"], nodes["y"], strict=True)]
    tree = shapely.STRtree(points)
    added = 0
    for i, pt in enumerate(points):
        for j in tree.query(pt, predicate="dwithin", distance=TRANSFER_TOLERANCE_DEG):
            j = int(j)
            if j <= i:
                continue
            key = (i, j)
            if key not in edges:
                edges[key] = 0.0
                added += 1
    log.debug("Added %d transfer edges", added)
    return edges


def dijkstra_with_paths(
    n_nodes: int, edges: dict[tuple[int, int], float], source: int
) -> tuple[np.ndarray, list[int | None]]:
    """Shortest-path distances plus the predecessor of each node.

    The predecessor array is the shortest-path tree — the actual route the
    time field travelled out from the centre. The hull renderer draws it so a
    reviewer can see which chain of stops produced a given contour, rather
    than inferring it from the polygon.
    """
    adjacency: list[list[tuple[int, float]]] = [[] for _ in range(n_nodes)]
    for (a, b), w in edges.items():
        adjacency[a].append((b, w))
        adjacency[b].append((a, w))

    dist = np.full(n_nodes, np.inf)
    dist[source] = 0.0
    prev: list[int | None] = [None] * n_nodes
    heap: list[tuple[float, int]] = [(0.0, source)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for v, w in adjacency[u]:
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    return dist, prev


def dijkstra(n_nodes: int, edges: dict[tuple[int, int], float], source: int) -> np.ndarray:
    """Single-source shortest path over the undirected weighted graph."""
    dist, _ = dijkstra_with_paths(n_nodes, edges, source)
    return dist


def _tier_hull(member_points: Iterable[Point]) -> shapely.Geometry | None:
    """Concave hull of the buffered member stops; None if no members."""
    buffered = [p.buffer(HULL_POINT_BUFFER_DEG) for p in member_points]
    if not buffered:
        return None
    merged = unary_union(buffered)
    hull = shapely.concave_hull(merged, ratio=CONCAVE_HULL_RATIO, allow_holes=False)
    if hull.is_empty:
        return None
    return hull


def run(
    *,
    stops_parquet: Path,
    lines_parquet: Path,
    cache_dir: Path,
    mode_label: str,
    centres: Sequence[Centre],
    tiers: Sequence[int],
    output_geojson: Path,
    exclude_line_pattern: str | None = None,
    exclude_stop_pattern: str | None = None,
) -> int:
    """Compute cumulative commute-tier hulls for one mode across all centres.

    Returns the number of hull features written. Centres that have no network
    node within ``CENTRE_SNAP_TOLERANCE_DEG`` are skipped — e.g. the tram
    network simply does not exist in Shepparton, so no tram hulls can radiate
    from there.
    """
    if not cache_dir.exists():
        raise FileNotFoundError(f"Transit-time cache not found: {cache_dir}")

    nodes = load_stop_nodes(
        stops_parquet, cache_dir, mode_label, exclude_stop_pattern=exclude_stop_pattern
    )
    edges = build_edges(lines_parquet, nodes, mode_label, exclude_line_pattern)
    edges = add_transfer_edges(nodes, edges)

    node_points = [Point(xy) for xy in zip(nodes["x"], nodes["y"], strict=True)]
    tree = shapely.STRtree(node_points)

    features: list[dict[str, object]] = []
    for centre in centres:
        centre_point = Point(centre.lon, centre.lat)
        nearest = int(tree.nearest(centre_point))
        snap_distance = centre_point.distance(node_points[nearest])
        if snap_distance > CENTRE_SNAP_TOLERANCE_DEG:
            log.info(
                "%s: centre %s has no %s node within ~%.0f m (nearest %.1f km) — skipping",
                mode_label,
                centre.name,
                mode_label,
                CENTRE_SNAP_TOLERANCE_DEG * 111_000,
                snap_distance * 111,
            )
            continue

        if centre.direct_times:
            # The cache is minutes-to-Southern-Cross, i.e. exactly this
            # centre's distance field, including real waits and transfers.
            times = nodes["minutes"].to_numpy(dtype=float)
        else:
            times = dijkstra(len(nodes), edges, nearest)

        for tier in sorted(tiers, reverse=True):
            member_idx = np.flatnonzero(times <= tier)
            hull = _tier_hull([node_points[int(i)] for i in member_idx])
            if hull is None:
                log.info(
                    "%s / %s / %dmin: no reachable stops — skipping tier",
                    mode_label,
                    centre.name,
                    tier,
                )
                continue
            features.append(
                {
                    "MODE": mode_label,
                    "transit_time_minutes_nearest_tier": float(tier),
                    "centre": centre.slug,
                    "centre_name": centre.name,
                    "point_count": len(member_idx),
                    "geometry": hull,
                }
            )
        log.info(
            "%s / %s: hulls done (reachable ≤60min: %d stops)",
            mode_label,
            centre.name,
            int((times <= max(tiers)).sum()),
        )

    if not features:
        raise ValueError(f"No hull features produced for MODE={mode_label!r}")

    gdf = gpd.GeoDataFrame(features, crs="EPSG:4326")
    output_geojson.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(output_geojson, driver="GeoJSON", engine="pyogrio")
    log.info(
        "Wrote %d hull features (%.1f KB) -> %s",
        len(gdf),
        output_geojson.stat().st_size / 1024,
        output_geojson,
    )
    return len(gdf)
