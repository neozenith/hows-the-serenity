"""Tile a single dissolved-isochrone duration into MVT XYZ tiles."""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd

from etl.config import ISOCHRONE_KEEP_PROPERTIES
from etl.steps.tile_layer import TilingResult
from etl.steps.tile_layer import run as tile_layer_run

log = logging.getLogger("etl.steps.tile_isochrone")


def run(
    *,
    input_parquet: Path,
    duration: int,
    output_dir: Path,
    mode: str = "foot",
    min_zoom: int = 9,
    max_zoom: int = 12,
    clean: bool = True,
) -> TilingResult:
    log.info("Reading dissolved isochrones <- %s", input_parquet)
    gdf = gpd.read_parquet(input_parquet)

    filtered = gdf[gdf["minutes"] == duration]
    if filtered.empty:
        raise ValueError(
            f"No isochrone row for duration={duration} in {input_parquet}. "
            f"Available: {sorted(gdf['minutes'].tolist())}"
        )
    log.info("Selected duration=%d (%d row, mode=%s)", duration, len(filtered), mode)

    layer_dir = f"iso_{mode}_{duration}"
    return tile_layer_run(
        gdf=filtered,
        output_dir=output_dir,
        layer_name="isochrone",
        layer_dir=layer_dir,
        keep_properties=ISOCHRONE_KEEP_PROPERTIES,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        clean=clean,
    )
