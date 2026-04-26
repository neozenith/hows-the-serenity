"""Publish SAL GeoParquet intermediate to public/data as the served GeoJSON."""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd

from etl.config import SAL_KEEP_PROPERTIES, SAL_SIMPLIFY_TOLERANCE
from etl.io.geojson import write_geojson

log = logging.getLogger("etl.steps.publish_sal")


def run(
    input_parquet: Path,
    output_geojson: Path,
    simplify_tolerance: float = SAL_SIMPLIFY_TOLERANCE,
) -> int:
    log.info("Reading GeoParquet intermediate <- %s", input_parquet)
    gdf = gpd.read_parquet(input_parquet)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)
    write_geojson(
        gdf,
        output_geojson,
        keep_properties=SAL_KEEP_PROPERTIES,
        simplify_tolerance=simplify_tolerance,
    )
    return len(gdf)
