"""Write a GeoDataFrame to GeoJSON with property pruning and coord rounding."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path

import geopandas as gpd

from etl.config import GEOJSON_COORD_PRECISION, OUTPUT_CRS

log = logging.getLogger("etl.io.geojson")


def write_geojson(
    gdf: gpd.GeoDataFrame,
    output_path: Path,
    keep_properties: Iterable[str],
    coord_precision: int = GEOJSON_COORD_PRECISION,
    simplify_tolerance: float = 0.0,
) -> None:
    """Write `gdf` to GeoJSON, retaining only `keep_properties` plus geometry.

    Always reprojects to EPSG:4326 (the only CRS GeoJSON officially supports
    per RFC 7946) and rounds coordinates to `coord_precision` decimal places
    via pyogrio's COORDINATE_PRECISION layer creation option.

    If `simplify_tolerance > 0`, applies Douglas-Peucker simplification (with
    topology preservation, so adjacent polygons stay edge-aligned) AFTER
    reprojection — so tolerance is in degrees of EPSG:4326.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    keep = list(keep_properties)
    missing = [p for p in keep if p not in gdf.columns]
    if missing:
        raise ValueError(
            f"Requested properties not present on input: {missing}. "
            f"Available: {[c for c in gdf.columns if c != 'geometry']}"
        )

    pruned = gdf[[*keep, "geometry"]].copy()

    if pruned.crs is None:
        raise ValueError("Input GeoDataFrame has no CRS — cannot reproject safely")
    if str(pruned.crs).upper() != OUTPUT_CRS.upper():
        log.info("Reprojecting %s -> %s", pruned.crs, OUTPUT_CRS)
        pruned = pruned.to_crs(OUTPUT_CRS)

    if simplify_tolerance > 0:
        log.info("Simplifying geometry (tolerance=%g deg, topology-preserving)", simplify_tolerance)
        pruned["geometry"] = pruned.geometry.simplify(
            tolerance=simplify_tolerance, preserve_topology=True
        )

    log.info(
        "Writing GeoJSON: %s (%d features, %d-dp precision)",
        output_path,
        len(pruned),
        coord_precision,
    )
    # pyogrio passes layer creation options through to OGR's GeoJSON driver.
    pruned.to_file(
        output_path,
        driver="GeoJSON",
        engine="pyogrio",
        COORDINATE_PRECISION=coord_precision,
    )
    log.info("Wrote %.1f MB", output_path.stat().st_size / 1_048_576)
