"""Extract PTV line / stop GeoJSONs into pruned GeoParquet intermediates.

The upstream files in `data/originals/ptv/` already have one feature per
route (lines) or per stop (stops) — no dissolve needed. This step just
strips properties we won't render and writes the canonical Parquet for
the tile step to consume.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path

import geopandas as gpd

log = logging.getLogger("etl.steps.extract_ptv")


def run(
    *,
    input_geojson: Path,
    output_parquet: Path,
    keep_properties: Iterable[str],
) -> int:
    if not input_geojson.exists():
        raise FileNotFoundError(f"PTV source not found: {input_geojson}")

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
    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    log.info("Writing GeoParquet -> %s", output_parquet)
    pruned.to_parquet(output_parquet, compression="zstd")
    log.info(
        "Wrote %.2f MB (%d features)",
        output_parquet.stat().st_size / 1_048_576,
        len(pruned),
    )
    return len(pruned)
