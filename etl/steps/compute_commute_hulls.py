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

Two properties of that cache constrain what can be built from it. It is
multi-modal — Google Maps returns the fastest journey by ANY public
transport, so a tram stop beside a station carries a train time — and it is
not monotonic along a corridor, because express patterns let a station
further out read faster than one closer in. Both break the subtraction, so
every candidate weight is reconciled against the along-track distance
between the pair and clamped to a plausible speed band for the mode.

Every centre, Southern Cross included, takes its distance field from the
graph. Reading it straight from the cache for one centre made membership
multi-modal while the geometry stayed single-mode, which put stops inside
tram contours that no tram reaches in the time.

Each mode stays a separate network: tram, metro train and regional train
graphs never share edges, matching the three separate hull layers.
"""

from __future__ import annotations

import heapq
import itertools
import json
import logging
import math
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import substring, unary_union
from shapely.ops import transform as shapely_transform

log = logging.getLogger("etl.steps.compute_commute_hulls")

# Snap tolerances, in EPSG:4326 degrees (~111 km per degree of latitude).
STOP_TO_LINE_TOLERANCE_DEG = 0.001  # ~110 m: stop counts as "on" a route shape
TRANSFER_TOLERANCE_DEG = 0.002  # ~220 m: same-station nodes join for free
CENTRE_SNAP_TOLERANCE_DEG = 0.01  # ~1.1 km: centre must be this close to a node
# Hull geometry is built in EPSG:3111 (VicGrid94), so every constant below is
# metres. Buffering in degrees was subtly wrong: at Melbourne's latitude a
# degree of longitude is 88 km against 111 km of latitude, so a `buffer(deg)`
# came out 21% narrower east-west than north-south.
HULL_CRS = "EPSG:3111"

# Station catchment: how far you can actually walk from a platform. Measured
# from this project's own `isochrones_foot` layer rather than assumed — the
# 15-minute contour has a median equivalent-circle radius of 839 m (IQR
# 738-928 m), i.e. an effective 3.4 km/h once the street network is followed,
# not the 4.4 km/h of a straight line.
WALK_15_MIN_RADIUS_M = 840.0
# The same measurement for the 5-minute contour: 269 m. Used for the ribbon
# along the track, because track between stations is not boardable — that
# ribbon is a geometric connector that keeps the contour simply-connected,
# not a claim of access.
WALK_5_MIN_RADIUS_M = 270.0

CONCAVE_HULL_RATIO = 0.15
# Max spacing between vertices fed to the concave hull. See `_tier_hull`.
HULL_SEGMENT_M = 1_000.0
# Douglas-Peucker tolerance applied to the finished contour. See `_tier_hull`.
HULL_SIMPLIFY_M = 50.0
# Morphological closing radius: dilate then erode by the same amount, which
# fills the notches where a corridor meets a station catchment at a narrow
# angle without growing the contour's overall extent.
HULL_CLOSING_M = 400.0


@dataclass(frozen=True)
class Centre:
    """A hull centre: where a set of commute contours radiates from."""

    slug: str
    name: str
    lon: float
    lat: float


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


# Degrees of latitude to kilometres. Longitude shrinks by cos(latitude); at
# Victoria's ~-37.8 that is a 21% correction, too large to ignore.
DEG_LAT_KM = 111.32


def _along_track_km(delta_deg: float, latitude: float) -> float:
    """Along-track distance in km for a projection delta in degrees.

    Shape coordinates are lon/lat, so a projected distance mixes both axes.
    Applying the cosine correction for the segment's latitude is accurate
    enough for a plausibility check on inter-stop spacing.
    """
    return abs(delta_deg) * DEG_LAT_KM * math.cos(math.radians(latitude))


def build_edges(
    lines_parquet: Path,
    nodes: pd.DataFrame,
    mode_label: str,
    exclude_line_pattern: str | None = None,
    speed_band: tuple[float, float] | None = None,
) -> dict[tuple[int, int], float]:
    """Edges between stops adjacent along any route shape of the mode.

    Weight = |minutes(A) - minutes(B)|, the telescoped point-to-point travel
    time along the line, extracted from the cached radial scalars.

    That subtraction assumes both cached times describe a journey on *this*
    mode. They often do not: the cache is multi-modal, so a tram stop beside
    a station carries a train time and the difference against its tram
    neighbour is fiction. ``speed_band`` reconciles each candidate weight
    against the along-track distance between the two stops and clamps
    anything implying an impossible speed for the mode.
    """
    minutes = nodes["minutes"].to_numpy()
    ys = nodes["y"].to_numpy(dtype=float)
    edges: dict[tuple[int, int], float] = {}
    clamped = 0
    for a, b, _part, da, db in _iter_adjacent_along_shapes(
        lines_parquet, nodes, mode_label, exclude_line_pattern
    ):
        key = (a, b) if a < b else (b, a)
        raw = abs(float(minutes[a] - minutes[b]))
        weight = raw
        if speed_band is not None:
            # Along-track distance comes free from the projection: da and db
            # are positions along the same shape, so |db - da| is rail
            # distance, not a straight-line chord.
            km = _along_track_km(abs(db - da), float((ys[a] + ys[b]) / 2))
            slowest, fastest = min(speed_band), max(speed_band)
            lo = km / fastest * 60.0
            hi = km / slowest * 60.0
            weight = min(max(raw, lo), hi)
            if abs(weight - raw) > 1e-9:
                clamped += 1
        prev = edges.get(key)
        if prev is None or weight < prev:
            edges[key] = weight
    if speed_band is not None:
        log.info(
            "%s: %d unique adjacency edges (%d weight candidates clamped to the %g-%g km/h band)",
            mode_label,
            len(edges),
            clamped,
            min(speed_band),
            max(speed_band),
        )
    else:
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


def _tree_lines(
    members: set[int],
    prev: Sequence[int | None],
    edge_paths: dict[tuple[int, int], LineString],
    node_points: Sequence[Point],
) -> list[LineString]:
    """The shortest-path tree branches that lie wholly inside one tier.

    Transfer edges (same-station nodes joined for free) have no track geometry,
    so they fall back to a straight segment — which is honest: a transfer is a
    walk across a platform, not a rail movement.
    """
    lines: list[LineString] = []
    for v in sorted(members):
        parent = prev[v]
        if parent is None or parent not in members:
            continue
        key = (parent, v) if parent < v else (v, parent)
        path = edge_paths.get(key)
        lines.append(
            path if path is not None else LineString([node_points[parent], node_points[v]])
        )
    return lines


@lru_cache(maxsize=1)
def _hull_transformers() -> tuple[
    Callable[[shapely.Geometry], shapely.Geometry],
    Callable[[shapely.Geometry], shapely.Geometry],
]:
    """WGS84 <-> VicGrid94 geometry transforms, built once.

    `pyproj.Transformer` construction is expensive relative to the transform
    itself, and `_tier_hull` runs once per centre per tier.
    """
    forward = Transformer.from_crs("EPSG:4326", HULL_CRS, always_xy=True)
    inverse = Transformer.from_crs(HULL_CRS, "EPSG:4326", always_xy=True)
    return (
        lambda geom: shapely_transform(forward.transform, geom),
        lambda geom: shapely_transform(inverse.transform, geom),
    )


def _fill_holes(geom: shapely.Geometry) -> shapely.Geometry:
    """Drop interior rings, keeping only each part's outline.

    Unioning a stop blob with a branching corridor leaves lens-shaped voids
    wherever two branches rejoin — the area between the Ararat and Maryborough
    lines out of Ballarat, say. Those voids are an artefact of how the shape was
    assembled, not a statement that the enclosed land is unreachable, and they
    read as noise. `concave_hull(allow_holes=False)` only covers the blob term,
    so the final geometry is cleaned here instead.
    """
    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    return unary_union([shapely.Polygon(p.exterior) for p in polys if p.geom_type == "Polygon"])


def _tier_hull(
    member_points: Iterable[Point],
    tree_lines: Iterable[LineString] = (),
) -> shapely.Geometry | None:
    """Contour enclosing the reachable stops *and* the tree that reaches them.

    Two terms, unioned:

    * each reachable station's 15-minute walking catchment — where a rider can
      actually start or finish a journey; and
    * a thin ribbon along the shortest-path tree's own track geometry.

    The station term alone was the original implementation, and it fails
    wherever stations are far apart. Between Ballarat and Ballan the hull draws
    a straight chord while the rail line bows south, so the very tree the
    contour is meant to describe runs outside it. Unioning the ribbon in makes
    containment structural rather than incidental: a shape built from the tree
    cannot exclude it.

    The two radii differ on purpose. A station gets the full 15-minute walk
    because you can board there; the track between stations gets the 5-minute
    radius, because that ribbon exists to keep the contour connected, not to
    claim you can flag down a train in a paddock.

    Input and output are EPSG:4326; the work happens in projected metres.
    """
    points = list(member_points)
    if not points:
        return None
    to_metres, to_degrees = _hull_transformers()
    buffered = [to_metres(p).buffer(WALK_15_MIN_RADIUS_M) for p in points]
    lines = [to_metres(ls) for ls in tree_lines]
    corridor = unary_union(lines).buffer(WALK_5_MIN_RADIUS_M) if lines else None
    base = unary_union(buffered if corridor is None else [*buffered, corridor])
    # Hull the corridor, not the bare stops. Hulling 16 isolated regional
    # stations threw straight chords tens of kilometres across empty farmland;
    # hulling the corridor's own outline keeps the contour near the rails while
    # still closing the wedge between two branches out of the same centre. On a
    # dense metro network the corridor is a mesh, so the result is the familiar
    # blob it always was.
    # Densify first: `concave_hull`'s ratio is relative to the longest edge in
    # the Delaunay triangulation of the input's *vertices*, so a corridor whose
    # outline has few, widely-spaced points degenerates to a convex hull no
    # matter how tight the ratio. Segmentizing gives the triangulation enough
    # vertices for the ratio to mean what it says.
    parts: list[shapely.Geometry] = [
        shapely.concave_hull(
            shapely.segmentize(base, HULL_SEGMENT_M),
            ratio=CONCAVE_HULL_RATIO,
            allow_holes=False,
        )
    ]
    # Union the corridor back in: concave_hull may cut a corner off a hairpin,
    # and containment of the tree is the one property this shape must have.
    if corridor is not None:
        parts.append(corridor)
    # Closing only ever adds area, so it cannot push the tree back outside.
    hull = _fill_holes(unary_union(parts).buffer(HULL_CLOSING_M).buffer(-HULL_CLOSING_M))
    # Segmentizing and buffering leave far more vertices than the shape needs.
    # Douglas-Peucker bounds its own deviation by the tolerance, so dilating by
    # that same tolerance afterwards guarantees the simplified ring still covers
    # everything the original did — containment survives the diet.
    hull = hull.simplify(HULL_SIMPLIFY_M).buffer(HULL_SIMPLIFY_M)
    if hull.is_empty:
        return None
    return to_degrees(hull)


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
    speed_band: tuple[float, float] | None = None,
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
    edges = build_edges(
        lines_parquet, nodes, mode_label, exclude_line_pattern, speed_band=speed_band
    )
    edges = add_transfer_edges(nodes, edges)
    # Track geometry per edge, so each tier's contour can be grown from the
    # rails the tree actually runs on rather than from chords between stops.
    edge_paths = build_edge_paths(lines_parquet, nodes, mode_label, exclude_line_pattern)

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

        # Always the graph, including Southern Cross. Using the cached
        # scalars for that one centre made membership multi-modal while the
        # geometry stayed single-mode, so a tram contour could contain a stop
        # 147 minutes away by tram because a train reaches it in 12.8 —
        # rendering as a node with no tree branch attached. One field for
        # both keeps every contour answerable by the network drawn under it.
        times, prev = dijkstra_with_paths(len(nodes), edges, nearest)

        for tier in sorted(tiers, reverse=True):
            member_idx = np.flatnonzero(times <= tier)
            members = {int(i) for i in member_idx}
            hull = _tier_hull(
                [node_points[int(i)] for i in member_idx],
                _tree_lines(members, prev, edge_paths, node_points),
            )
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
