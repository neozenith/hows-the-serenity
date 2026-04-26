"""Clip a GeoDataFrame to a tile and encode the result as MVT bytes."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

import geopandas as gpd
import mapbox_vector_tile as mvt
from mapbox_vector_tile.encoder import on_invalid_geometry_make_valid
from shapely.geometry import box

from etl.tiling.coords import TileBounds

log = logging.getLogger("etl.tiling.encode")

# MVT default extent — the canonical 0-4096 grid every Mapbox/MVT consumer expects.
MVT_EXTENT = 4096


def encode_tile(
    *,
    gdf_3857: gpd.GeoDataFrame,
    tile: TileBounds,
    layer_name: str,
    keep_properties: Iterable[str],
) -> bytes | None:
    """Encode the features of `gdf_3857` that intersect `tile` as MVT bytes.

    `gdf_3857` must already be in EPSG:3857. Returns None if the tile contains
    no features (caller skips writing — saves disk + git churn).
    """
    tile_bbox = box(tile.minx, tile.miny, tile.maxx, tile.maxy)

    # Spatial-index narrow to candidates, then exact-test, then clip.
    candidates_idx = list(gdf_3857.sindex.query(tile_bbox, predicate="intersects"))
    if not candidates_idx:
        return None

    candidates = gdf_3857.iloc[candidates_idx]
    clipped = candidates.intersection(tile_bbox)
    mask = ~clipped.is_empty
    if not mask.any():
        return None

    candidates = candidates[mask]
    clipped = clipped[mask]

    keep = list(keep_properties)
    # Pull each property column once as a numpy array — much faster than
    # iterrows() / per-row __getitem__ on the DataFrame.
    prop_cols = {p: candidates[p].values for p in keep}
    features: list[dict[str, Any]] = [
        {"geometry": geom, "properties": {p: prop_cols[p][i] for p in keep}}
        for i, geom in enumerate(clipped.values)
        if not geom.is_empty
    ]

    if not features:
        return None

    encoded: bytes = mvt.encode(
        [{"name": layer_name, "features": features}],
        default_options={
            "quantize_bounds": (tile.minx, tile.miny, tile.maxx, tile.maxy),
            "extents": MVT_EXTENT,
            "on_invalid_geometry": on_invalid_geometry_make_valid,
        },
    )
    return encoded
