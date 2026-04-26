"""Tile-coordinate math: enumerate XYZ tiles covering a WGS84 bounding box."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import mercantile


@dataclass(frozen=True)
class TileBounds:
    """Tile address + projected (EPSG:3857) bounds in metres."""

    z: int
    x: int
    y: int
    minx: float
    miny: float
    maxx: float
    maxy: float


def tiles_covering_bbox(
    *,
    west: float,
    south: float,
    east: float,
    north: float,
    min_zoom: int,
    max_zoom: int,
) -> Iterator[TileBounds]:
    """Yield every (z, x, y) tile covering the WGS84 bbox at zoom ∈ [min_zoom, max_zoom].

    The bbox itself is in EPSG:4326 (lon/lat). Returned tile bounds are in
    EPSG:3857 (metres) so they can be used directly as MVT `quantize_bounds`
    against geometries reprojected to Web Mercator.
    """
    if min_zoom > max_zoom:
        raise ValueError(f"min_zoom ({min_zoom}) > max_zoom ({max_zoom})")

    for z in range(min_zoom, max_zoom + 1):
        for tile in mercantile.tiles(west, south, east, north, zooms=z):
            xy = mercantile.xy_bounds(tile)
            yield TileBounds(
                z=tile.z,
                x=tile.x,
                y=tile.y,
                minx=xy.left,
                miny=xy.bottom,
                maxx=xy.right,
                maxy=xy.top,
            )
