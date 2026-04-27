"""Publish PTV commute-tier hull GeoJSON to public/data/.

The upstream files (`ptv_commute_tier_hulls_metro_{train,tram}.geojson`) are
4 polygons each totalling ~3 KB — well below the threshold where MVT tiling
would help. Just prune to the properties the frontend renders and copy to
public/data/ as static GeoJSON; loaded directly via Deck.GL's GeoJsonLayer.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path

import geopandas as gpd

log = logging.getLogger("etl.steps.publish_commute_hulls")


def run(
    *,
    input_geojson: Path,
    output_geojson: Path,
    keep_properties: Iterable[str],
) -> int:
    if not input_geojson.exists():
        raise FileNotFoundError(f"Commute-hulls source not found: {input_geojson}")

    log.info("Reading %s", input_geojson)
    gdf = gpd.read_file(input_geojson)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)

    keep = list(keep_properties)
    missing = [p for p in keep if p not in gdf.columns]
    if missing:
        raise ValueError(
            f"Requested properties not present on input: {missing}. "
            f"Available: {[c for c in gdf.columns if c != 'geometry']}"
        )

    pruned = gdf[[*keep, "geometry"]].copy()
    output_geojson.parent.mkdir(parents=True, exist_ok=True)
    log.info("Writing pruned GeoJSON -> %s", output_geojson)
    # Driver=GeoJSON, EPSG:4326 — same defaults as the rest of the pipeline.
    pruned.to_file(output_geojson, driver="GeoJSON", engine="pyogrio")
    log.info(
        "Wrote %.1f KB (%d features)",
        output_geojson.stat().st_size / 1024,
        len(pruned),
    )
    return len(pruned)
