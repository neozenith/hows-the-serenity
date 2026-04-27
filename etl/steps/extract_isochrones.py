"""Concat per-stop foot-isochrone GeoJSONs and dissolve into walkability corridors.

Source: <input_dir>/*.geojson — one file per PTV stop, each containing 5/10/15-min
contour features. Output: a single GeoParquet with one row per requested duration,
where each row's geometry is the union (dissolve) of all per-stop polygons for that
contour. Per-stop properties (STOP_ID, STOP_NAME, source_file, etc.) are dropped
because they're meaningless after the dissolve — they'd point at an arbitrary stop
inside the merged corridor.
"""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd
import pandas as pd

log = logging.getLogger("etl.steps.extract_isochrones")


def run(
    *,
    input_dir: Path,
    output_parquet: Path,
    durations: tuple[int, ...],
    mode: str = "foot",
) -> int:
    if not input_dir.exists():
        raise FileNotFoundError(f"Isochrone source directory not found: {input_dir}")

    sources = sorted(input_dir.glob("*.geojson"))
    if not sources:
        raise FileNotFoundError(f"No *.geojson files found in {input_dir}")
    log.info("Reading %d per-stop isochrone files from %s", len(sources), input_dir)

    parts: list[gpd.GeoDataFrame] = []
    for src in sources:
        gdf = gpd.read_file(str(src))
        # Filter to requested contours up front — saves memory + dissolve time.
        gdf = gdf[gdf["contour_time_minutes"].isin(durations)]
        if not gdf.empty:
            parts.append(gdf[["contour_time_minutes", "geometry"]])

    log.info("Concatenating %d non-empty stop frames", len(parts))
    combined = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs=parts[0].crs)
    log.info("Pre-dissolve: %d features across %d durations", len(combined), len(durations))

    log.info("Dissolving by contour_time_minutes (%s)", list(durations))
    dissolved = combined.dissolve(by="contour_time_minutes", as_index=False)

    # Replace the column name with the cleaner `minutes`, attach mode label.
    dissolved = dissolved.rename(columns={"contour_time_minutes": "minutes"})
    dissolved["isochrone_mode"] = mode
    dissolved = dissolved[["minutes", "isochrone_mode", "geometry"]]

    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    log.info("Writing GeoParquet -> %s", output_parquet)
    dissolved.to_parquet(output_parquet, compression="zstd")
    log.info(
        "Wrote %.2f MB (%d corridor rows: minutes=%s)",
        output_parquet.stat().st_size / 1_048_576,
        len(dissolved),
        sorted(dissolved["minutes"].tolist()),
    )
    return len(dissolved)
