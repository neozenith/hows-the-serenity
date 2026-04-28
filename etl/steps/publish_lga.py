"""Publish LGA GeoParquet intermediate to public/data as the served GeoJSON.

Mirrors `publish_sal` but for the LGA_2024 vintage. The bootstrap parquet
under `data/converted/lga_2024_aust_gda2020.parquet` was sourced from the
upstream isochrones project's converted LGA snapshot (originally derived
from the ABS LGA_2024 shapefile). It carries some NSW border LGAs in the
buffer; we state-filter to Victoria here so the served GeoJSON stays
Vic-only and matches the rental-data scope.
"""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd

from etl.config import LGA_KEEP_PROPERTIES, LGA_SIMPLIFY_TOLERANCE
from etl.io.geojson import write_geojson

log = logging.getLogger("etl.steps.publish_lga")


def run(
    input_parquet: Path,
    output_geojson: Path,
    *,
    state_filter: str | None = "Victoria",
    simplify_tolerance: float = LGA_SIMPLIFY_TOLERANCE,
) -> int:
    log.info("Reading LGA GeoParquet intermediate <- %s", input_parquet)
    gdf = gpd.read_parquet(input_parquet)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)

    if state_filter is not None:
        if "STE_NAME21" not in gdf.columns:
            raise ValueError(f"state_filter={state_filter!r} requested but no STE_NAME21 column")
        before = len(gdf)
        gdf = gdf[gdf["STE_NAME21"] == state_filter]
        log.info(
            "Filtered STE_NAME21==%r: %d -> %d features",
            state_filter,
            before,
            len(gdf),
        )

    write_geojson(
        gdf,
        output_geojson,
        keep_properties=LGA_KEEP_PROPERTIES,
        simplify_tolerance=simplify_tolerance,
    )
    return len(gdf)
