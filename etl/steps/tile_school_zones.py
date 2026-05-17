"""Tile one school-zone level (filtered out of the merged parquet) into MVT tiles.

Levels are derived by `extract_school_zones.parse_level` from each source
filename — e.g. `primary`, `secondary_year7`, `standalone_juniorsec`.

Mirrors the tile_isochrone / tile_ptv pattern: one invocation per level
so the frontend can toggle each independently.
"""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd

from etl.steps.extract_school_zones import KEEP_PROPERTIES
from etl.steps.tile_layer import TilingResult
from etl.steps.tile_layer import run as tile_layer_run

log = logging.getLogger("etl.steps.tile_school_zones")


def run(
    *,
    input_parquet: Path,
    level: str,
    output_dir: Path,
    # School catchments are suburb-to-LGA-scale polygons; z=11 is the
    # sweet spot for legibility — z=13 generates ~21k tiles x 82MB per
    # level, way too much for git. z=11 keeps each level under ~5MB
    # while still rendering crisp polygons at street-level zoom.
    min_zoom: int = 9,
    max_zoom: int = 11,
    clean: bool = True,
) -> TilingResult:
    """Tile the subset of `input_parquet` rows where `level == <level>`."""
    log.info("Reading merged school-zones <- %s", input_parquet)
    gdf = gpd.read_parquet(input_parquet)
    filtered = gdf[gdf["level"] == level]
    if filtered.empty:
        raise ValueError(
            f"No school-zone rows for level={level!r} in {input_parquet}. "
            f"Available levels: {sorted(gdf['level'].unique().tolist())}"
        )
    log.info("Selected level=%s (%d features)", level, len(filtered))
    return tile_layer_run(
        gdf=filtered,
        output_dir=output_dir,
        layer_name="school_zone",
        layer_dir=f"school_zones_{level}",
        keep_properties=KEEP_PROPERTIES,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        clean=clean,
    )
