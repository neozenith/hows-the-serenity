"""Render commute-hull layers to PNG for visual review.

This is a diagnostic surface, not a pipeline artefact. Hull geometry is hard
to reason about numerically — "why does this contour bulge here" is a
question best answered by looking at the polygon next to the stops that
produced it. Each render therefore shows three things together:

- the hull polygon per tier, drawn as nested translucent bands
- every stop the tier actually contained, which is the hull's literal input
- the mode's route shapes, for geographic context

An optional slippy-tile grid is overlaid and labelled ``z/x/y`` so a reviewer
can name a specific cell ("the spike in 13/7393/5026") and have that address
resolve to the same place for everyone. Zoom is chosen automatically to keep
the labels readable unless pinned with ``--zoom``.

Membership is recomputed through the same functions the compute step uses,
rather than read back from the published GeoJSON, so what is drawn is what
the hull algorithm actually saw.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import geopandas as gpd
import matplotlib
import mercantile
import numpy as np
import shapely
from shapely.geometry import LineString, Point

matplotlib.use("Agg")
import matplotlib.colors
import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.patches import Patch, Rectangle

from etl.steps.compute_commute_hulls import (
    Centre,
    add_transfer_edges,
    build_edge_paths,
    build_edges,
    dijkstra_with_paths,
    load_stop_nodes,
)

log = logging.getLogger("etl.steps.render_commute_hulls")

# Tier draw order is largest-first so smaller tiers layer on top.
TIER_FILL_ALPHA = {15: 0.34, 30: 0.26, 45: 0.18, 60: 0.11}
# Padding around the drawn extent, as a fraction of its larger dimension.
EXTENT_PAD_FRACTION = 0.06
# Target number of tile columns across the view; drives automatic zoom choice.
TARGET_TILE_COLUMNS = 9
# Automatic zoom steps back until the whole grid fits under this many tiles,
# so every cell keeps a readable z/x/y label. A tall, narrow extent (Shepparton,
# Bendigo) produces far more rows than columns, which is what used to push
# those views past the labelling threshold and leave them unlabelled.
MAX_LABELLED_TILES = 260


@dataclass(frozen=True)
class RenderExtent:
    west: float
    south: float
    east: float
    north: float

    @property
    def width(self) -> float:
        return self.east - self.west

    @property
    def height(self) -> float:
        return self.north - self.south


def _padded_extent(gdf: gpd.GeoDataFrame) -> RenderExtent:
    west, south, east, north = gdf.total_bounds
    pad = max(east - west, north - south) * EXTENT_PAD_FRACTION
    return RenderExtent(west - pad, south - pad, east + pad, north + pad)


def _auto_zoom(extent: RenderExtent) -> int:
    """Deepest zoom that still keeps every tile label readable.

    Picks the smallest zoom giving TARGET_TILE_COLUMNS across, then steps
    back out while the total tile count would exceed MAX_LABELLED_TILES.
    Stepping back on *total* count (not columns) is what keeps tall, narrow
    extents labelled — they have few columns but many rows.
    """
    zoom = 19
    for candidate in range(1, 20):
        if extent.width / (360.0 / (2**candidate)) >= TARGET_TILE_COLUMNS:
            zoom = candidate
            break
    while zoom > 1:
        tiles = sum(
            1
            for _ in mercantile.tiles(
                extent.west, extent.south, extent.east, extent.north, zooms=[zoom]
            )
        )
        if tiles <= MAX_LABELLED_TILES:
            break
        zoom -= 1
    return zoom


def _draw_tile_grid(ax: Axes, extent: RenderExtent, zoom: int) -> int:
    """Overlay the slippy-tile grid, labelling cells as z/x/y. Returns count."""
    tiles = list(
        mercantile.tiles(extent.west, extent.south, extent.east, extent.north, zooms=[zoom])
    )
    label = len(tiles) <= MAX_LABELLED_TILES
    for tile in tiles:
        b = mercantile.bounds(tile)
        ax.add_patch(
            Rectangle(
                (b.west, b.south),
                b.east - b.west,
                b.north - b.south,
                fill=False,
                edgecolor="#5a6b7d",
                linewidth=0.4,
                linestyle=":",
                zorder=1,
            )
        )
        if label:
            ax.annotate(
                f"{tile.z}/{tile.x}/{tile.y}",
                (b.west + (b.east - b.west) * 0.5, b.south + (b.north - b.south) * 0.5),
                fontsize=4.5,
                color="#7c8fa3",
                ha="center",
                va="center",
                zorder=2,
            )
    log.info("Tile grid: %d tiles at z%d (labelled=%s)", len(tiles), zoom, label)
    return len(tiles)


def _tier_color(base: str, tier: int) -> tuple[float, float, float, float]:
    rgba = matplotlib.colors.to_rgba(base)
    return (rgba[0], rgba[1], rgba[2], TIER_FILL_ALPHA.get(tier, 0.12))


@dataclass(frozen=True)
class NetworkGraph:
    """The reachable graph as the hull algorithm sees it, ready to draw."""

    xs: np.ndarray
    ys: np.ndarray
    times: np.ndarray
    # (i, j) pairs of adjacent reachable stops.
    edges: list[tuple[int, int]]
    # (child, parent) pairs forming the shortest-path tree from the centre.
    tree: list[tuple[int, int]]
    source: int
    # Track geometry per adjacency edge, keyed (min, max). Edges without an
    # entry fall back to a straight chord.
    paths: dict[tuple[int, int], LineString]

    def edge_xy(self, a: int, b: int) -> tuple[Sequence[float], Sequence[float]]:
        """Coordinates to draw for an edge — the rails where we have them."""
        path = self.paths.get((a, b) if a < b else (b, a))
        if path is not None and not path.is_empty:
            xs, ys = path.xy
            return list(xs), list(ys)
        return [self.xs[a], self.xs[b]], [self.ys[a], self.ys[b]]


def _draw_network(ax: Axes, graph: NetworkGraph, budget: float) -> None:
    """Draw reachable edges, the shortest-path tree, and per-node time labels.

    Every reachable edge is drawn faintly; the shortest-path tree — the route
    the time field actually took out from the centre — is drawn brighter on
    top. Each node carries its cumulative minutes-from-centre to 1dp, so a
    contour that looks wrong can be traced back to the specific hop that
    produced it.
    """
    # Edges are filtered to the budget at draw time, not at graph-build time,
    # so one NetworkGraph renders every tier: a 15-min view shows only the
    # spanning tree that fits inside 15 minutes.
    within = graph.times <= budget
    for i, j in graph.edges:
        if not (within[i] and within[j]):
            continue
        ex, ey = graph.edge_xy(i, j)
        ax.plot(ex, ey, color="#4b5f75", linewidth=0.6, zorder=6, solid_capstyle="round")
    for child, parent in graph.tree:
        if not (within[child] and within[parent]):
            continue
        ex, ey = graph.edge_xy(child, parent)
        ax.plot(
            ex,
            ey,
            color="#5ad2f4",
            linewidth=1.3,
            alpha=0.9,
            zorder=7,
            solid_capstyle="round",
        )

    reachable = np.flatnonzero(graph.times <= budget)
    ax.scatter(
        graph.xs[reachable],
        graph.ys[reachable],
        s=14,
        c="#ffd166",
        edgecolors="#11161c",
        linewidths=0.4,
        zorder=8,
    )
    for idx in reachable:
        ax.annotate(
            f"{graph.times[idx]:.1f}",
            (graph.xs[idx], graph.ys[idx]),
            textcoords="offset points",
            xytext=(4, 3),
            fontsize=5.0,
            color="#ffe9a8",
            zorder=9,
            path_effects=[pe.withStroke(linewidth=1.6, foreground="#11161c")],
        )
    ax.scatter(
        [graph.xs[graph.source]],
        [graph.ys[graph.source]],
        s=170,
        marker="*",
        c="#ff5d73",
        edgecolors="#11161c",
        linewidths=0.6,
        zorder=10,
    )


def render(
    *,
    hulls: gpd.GeoDataFrame,
    graph: NetworkGraph | None,
    lines: gpd.GeoDataFrame | None,
    budget: float,
    title: str,
    base_color: str,
    output_png: Path,
    zoom: int | None,
) -> Path:
    """Draw one hull layer with its input stops and a labelled tile grid."""
    extent = _padded_extent(hulls)
    resolved_zoom = zoom if zoom is not None else _auto_zoom(extent)

    # Latitude compression: 1 deg lon is cos(lat) as wide as 1 deg lat.
    mid_lat = (extent.south + extent.north) / 2
    aspect = 1.0 / max(np.cos(np.radians(mid_lat)), 1e-6)
    fig_w = 15.0
    fig_h = max(4.0, min(20.0, fig_w * (extent.height / extent.width) / aspect))
    fig, ax = plt.subplots(figsize=(fig_w, fig_h))
    fig.patch.set_facecolor("#11161c")
    ax.set_facecolor("#11161c")

    _draw_tile_grid(ax, extent, resolved_zoom)

    if lines is not None and not lines.empty:
        lines.plot(ax=ax, color="#3d4d5e", linewidth=0.6, zorder=3)

    handles: list[Patch] = []
    for tier in sorted(hulls["transit_time_minutes_nearest_tier"].unique(), reverse=True):
        band = hulls[hulls["transit_time_minutes_nearest_tier"] == tier]
        band.plot(
            ax=ax,
            facecolor=_tier_color(base_color, int(tier)),
            edgecolor=base_color,
            linewidth=1.4,
            zorder=4,
        )
        pts = band["point_count"].iloc[0] if "point_count" in band.columns else "?"
        handles.append(
            Patch(
                facecolor=_tier_color(base_color, int(tier)),
                edgecolor=base_color,
                label=f"{int(tier)} min · {pts} stops",
            )
        )

    if graph is not None:
        _draw_network(ax, graph, budget)
        handles.append(Patch(facecolor="#5ad2f4", edgecolor="#5ad2f4", label="shortest-path tree"))
        handles.append(
            Patch(facecolor="#ffd166", edgecolor="#ffd166", label="stop · cumulative min")
        )

    ax.set_xlim(extent.west, extent.east)
    ax.set_ylim(extent.south, extent.north)
    ax.set_aspect(aspect)
    ax.set_title(title, color="#e6edf3", fontsize=12, fontweight="bold")
    ax.tick_params(colors="#7c8fa3", labelsize=7)
    for spine in ax.spines.values():
        spine.set_color("#2b3541")
    legend = ax.legend(handles=handles, loc="upper left", fontsize=8, framealpha=0.85)
    legend.get_frame().set_facecolor("#1b222b")
    for text in legend.get_texts():
        text.set_color("#e6edf3")

    output_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_png, dpi=130, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    log.info("Wrote %s (%.0f KB)", output_png, output_png.stat().st_size / 1024)
    return output_png


def run(
    *,
    hulls_geojson: Path,
    stops_parquet: Path,
    lines_parquet: Path,
    cache_dir: Path,
    mode_label: str,
    mode_slug: str,
    centres: Sequence[Centre],
    base_color: str,
    output_dir: Path,
    zoom: int | None = None,
    tiers: Sequence[int] = (15, 30, 45, 60),
    exclude_line_pattern: str | None = None,
    exclude_stop_pattern: str | None = None,
) -> list[Path]:
    """Render one PNG per centre present in the hull file, plus a combined one."""
    if not hulls_geojson.exists():
        raise FileNotFoundError(
            f"Hull GeoJSON not found: {hulls_geojson} — run `etl extract commute-hulls` first"
        )
    hulls = gpd.read_file(hulls_geojson)

    # Recompute stop membership so the render shows the algorithm's real input.
    nodes = load_stop_nodes(
        stops_parquet, cache_dir, mode_label, exclude_stop_pattern=exclude_stop_pattern
    )
    edges = add_transfer_edges(
        nodes, build_edges(lines_parquet, nodes, mode_label, exclude_line_pattern)
    )
    edge_paths = build_edge_paths(lines_parquet, nodes, mode_label, exclude_line_pattern)
    node_points = gpd.GeoDataFrame(
        nodes.copy(), geometry=gpd.points_from_xy(nodes["x"], nodes["y"]), crs="EPSG:4326"
    )
    lines = gpd.read_parquet(lines_parquet, columns=["MODE", "geometry"])
    lines = lines[lines["MODE"] == mode_label]

    by_slug = {c.slug: c for c in centres}
    # Same STRtree nearest-node snap the compute step uses, so the render
    # resolves each centre to the identical graph node.
    tree = shapely.STRtree(list(node_points.geometry))
    xs = nodes["x"].to_numpy(dtype=float)
    ys = nodes["y"].to_numpy(dtype=float)
    budget = float(max(tiers))
    written: list[Path] = []

    for slug in sorted(hulls["centre"].unique()):
        subset = hulls[hulls["centre"] == slug]
        centre = by_slug.get(str(slug))
        graph = None
        if centre is not None:
            nearest = int(tree.nearest(Point(centre.lon, centre.lat)))
            graph_times, prev = dijkstra_with_paths(len(nodes), edges, nearest)
            # Southern Cross uses the cached scalars as its distance field, so
            # label with those; the tree still shows the graph's own routing.
            times = nodes["minutes"].to_numpy(dtype=float) if centre.direct_times else graph_times
            reachable = set(np.flatnonzero(times <= budget).tolist())
            graph = NetworkGraph(
                xs=xs,
                ys=ys,
                times=times,
                edges=[(a, b) for (a, b) in edges if a in reachable and b in reachable],
                tree=[
                    (child, parent)
                    for child, parent in enumerate(prev)
                    if parent is not None and child in reachable and parent in reachable
                ],
                source=nearest,
                paths=edge_paths,
            )
        centre_name = centre.name if centre else str(slug)
        written.append(
            render(
                hulls=subset,
                graph=graph,
                lines=lines,
                budget=budget,
                title=f"{mode_label} · {centre_name} · 15/30/45/60 min",
                base_color=base_color,
                output_png=output_dir / f"hulls_{mode_slug}__{slug}.png",
                zoom=zoom,
            )
        )

        # One view per tier: a single contour with the spanning tree clipped
        # to that same budget. Nesting four tiers in one image hides which
        # band a given artifact belongs to; isolating them makes each
        # contour's own input obvious, and the tighter extent gives the
        # inner tiers a deeper, better-labelled tile grid.
        for tier in sorted(tiers):
            band = subset[subset["transit_time_minutes_nearest_tier"] == float(tier)]
            if band.empty:
                log.info("%s / %s: no %d-min hull to render", mode_label, centre_name, tier)
                continue
            written.append(
                render(
                    hulls=band,
                    graph=graph,
                    lines=lines,
                    budget=float(tier),
                    title=f"{mode_label} · {centre_name} · {tier} min only",
                    base_color=base_color,
                    output_png=output_dir / f"hulls_{mode_slug}__{slug}__t{tier:02d}.png",
                    zoom=zoom,
                )
            )

    # The combined view omits the graph: overlaying six shortest-path trees
    # and every node label makes it unreadable, and per-centre files already
    # carry that detail.
    written.append(
        render(
            hulls=hulls,
            graph=None,
            lines=lines,
            budget=budget,
            title=f"{mode_label} · all centres combined",
            base_color=base_color,
            output_png=output_dir / f"hulls_{mode_slug}__ALL.png",
            zoom=zoom,
        )
    )
    return written
