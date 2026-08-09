"""Publish the commute network graph as debuggable map layers.

The hull polygons are a lossy summary of a graph. When a contour looks wrong
the useful question is "which stops and which hops produced it", and that is
only answerable against the graph itself. These artefacts put the same
information the review PNGs carry onto the live map, so a shape can be
interrogated in place rather than by regenerating an image:

- ``commute_centres.geojson``                  every hull centre, per mode
- ``commute_mst_<mode>__<centre>.geojson``     shortest-path tree, along track
- ``commute_times_<mode>__<centre>.geojson``   reachable stops + minutes

Tier is stamped as a property rather than split across files: one fetch per
(mode, centre) serves all four tier layers, and the frontend filters. That
keeps 8 network files where per-tier files would have meant 64.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely
from shapely.geometry import LineString, Point

from etl.steps.compute_commute_hulls import (
    Centre,
    add_transfer_edges,
    build_edge_paths,
    build_edges,
    dijkstra_with_paths,
    load_stop_nodes,
)

log = logging.getLogger("etl.steps.publish_commute_graph")


def _tier_for(minutes: float, tiers: Sequence[int]) -> int | None:
    """Smallest tier that contains ``minutes``; None if beyond the last."""
    for tier in sorted(tiers):
        if minutes <= tier:
            return tier
    return None


def run(
    *,
    stops_parquet: Path,
    lines_parquet: Path,
    cache_dir: Path,
    mode_label: str,
    mode_slug: str,
    centres: Sequence[Centre],
    tiers: Sequence[int],
    output_dir: Path,
    exclude_line_pattern: str | None = None,
    exclude_stop_pattern: str | None = None,
    speed_band: tuple[float, float] | None = None,
) -> list[Path]:
    """Write the MST and stop-time layers for each reachable centre."""
    nodes = load_stop_nodes(
        stops_parquet, cache_dir, mode_label, exclude_stop_pattern=exclude_stop_pattern
    )
    edges = add_transfer_edges(
        nodes,
        build_edges(lines_parquet, nodes, mode_label, exclude_line_pattern, speed_band=speed_band),
    )
    edge_paths = build_edge_paths(lines_parquet, nodes, mode_label, exclude_line_pattern)

    xs = nodes["x"].to_numpy(dtype=float)
    ys = nodes["y"].to_numpy(dtype=float)
    names = nodes["name"].tolist()
    points = [Point(x, y) for x, y in zip(xs, ys, strict=True)]
    tree = shapely.STRtree(points)
    budget = float(max(tiers))

    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    centre_records: list[dict[str, object]] = []

    for centre in centres:
        nearest = int(tree.nearest(Point(centre.lon, centre.lat)))
        # Same reachability rule the hulls use: a centre off this network
        # produces no layers rather than a misleading empty one.
        if Point(centre.lon, centre.lat).distance(points[nearest]) > 0.01:
            continue

        graph_times, prev = dijkstra_with_paths(len(nodes), edges, nearest)
        times = graph_times
        centre_records.append(
            {
                "centre": centre.slug,
                "centre_name": centre.name,
                "MODE": mode_label,
                "geometry": Point(centre.lon, centre.lat),
            }
        )

        time_records: list[dict[str, object]] = []
        for i, minutes in enumerate(times):
            if not math.isfinite(minutes) or minutes > budget:
                continue
            tier = _tier_for(float(minutes), tiers)
            if tier is None:
                continue
            time_records.append(
                {
                    "STOP_NAME": names[i],
                    "minutes": round(float(minutes), 1),
                    "tier": tier,
                    "centre": centre.slug,
                    "MODE": mode_label,
                    "geometry": points[i],
                }
            )

        mst_records: list[dict[str, object]] = []
        for child, parent in enumerate(prev):
            if parent is None:
                continue
            far = max(float(times[child]), float(times[parent]))
            tier = _tier_for(far, tiers) if math.isfinite(far) else None
            if tier is None:
                continue
            key = (child, parent) if child < parent else (parent, child)
            geom = edge_paths.get(key)
            if geom is None or geom.is_empty:
                geom = LineString([(xs[parent], ys[parent]), (xs[child], ys[child])])
            mst_records.append(
                {
                    "from_stop": names[parent],
                    "to_stop": names[child],
                    "minutes": round(float(times[child]), 1),
                    "tier": tier,
                    "centre": centre.slug,
                    "MODE": mode_label,
                    "geometry": geom,
                }
            )

        for records, kind in ((time_records, "times"), (mst_records, "mst")):
            if not records:
                log.info("%s / %s: no %s records", mode_label, centre.name, kind)
                continue
            path = output_dir / f"commute_{kind}_{mode_slug}__{centre.slug}.geojson"
            gpd.GeoDataFrame(records, crs="EPSG:4326").to_file(
                path, driver="GeoJSON", engine="pyogrio"
            )
            log.info(
                "Wrote %s — %.1f KB (%d features)",
                path.name,
                path.stat().st_size / 1024,
                len(records),
            )
            written.append(path)

    if centre_records:
        # Appended to across modes: each mode contributes its own reachable
        # centres, so the layer shows which network each marker belongs to.
        path = output_dir / "commute_centres.geojson"
        existing = (
            gpd.read_file(path)
            if path.exists()
            else gpd.GeoDataFrame(columns=["centre", "centre_name", "MODE", "geometry"])
        )
        existing = (
            existing[existing.get("MODE", np.array([])) != mode_label]
            if len(existing)
            else existing
        )
        merged = gpd.GeoDataFrame(
            list(existing.to_dict("records")) + centre_records, crs="EPSG:4326"
        )
        merged.to_file(path, driver="GeoJSON", engine="pyogrio")
        log.info("Wrote %s — %d centre markers", path.name, len(merged))
        written.append(path)

    return written
