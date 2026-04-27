"""Tile a PTV (lines or stops) GeoParquet intermediate into MVT XYZ tiles."""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd

from etl.steps.tile_layer import TilingResult
from etl.steps.tile_layer import run as tile_layer_run

log = logging.getLogger("etl.steps.tile_ptv")


def run(
    *,
    input_parquet: Path,
    output_dir: Path,
    layer_name: str,
    layer_dir: str,
    keep_properties: tuple[str, ...],
    min_zoom: int = 9,
    max_zoom: int = 12,
    clean: bool = True,
) -> TilingResult:
    log.info("Reading PTV parquet <- %s", input_parquet)
    gdf = gpd.read_parquet(input_parquet)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)
    return tile_layer_run(
        gdf=gdf,
        output_dir=output_dir,
        layer_name=layer_name,
        layer_dir=layer_dir,
        keep_properties=keep_properties,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        clean=clean,
    )
