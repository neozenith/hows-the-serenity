"""Extract SAL_2021 shapefile from its zip into a GeoParquet intermediate.

The Parquet checkpoint exists so iteration on the publish step (precision,
property selection, future simplification) does not pay the multi-second
cost of re-reading the 142 MB shapefile every time.
"""

from __future__ import annotations

import logging
from pathlib import Path

from etl.io.shapefile import read_zipped_shapefile

log = logging.getLogger("etl.steps.extract_sal")


def run(
    input_zip: Path,
    output_parquet: Path,
    state_filter: str | None = "Victoria",
) -> int:
    """Extract the SAL shapefile into a GeoParquet, optionally state-filtered.

    `state_filter` matches against `STE_NAME21` verbatim ("Victoria",
    "New South Wales", etc.). Defaults to "Victoria" since this app is
    Melbourne-focused and the other states' boundaries are noise. Pass
    None to keep all states.
    """
    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    gdf = read_zipped_shapefile(input_zip)

    if state_filter is not None:
        if "STE_NAME21" not in gdf.columns:
            raise ValueError(f"state_filter={state_filter!r} requested but no STE_NAME21 column")
        before = len(gdf)
        gdf = gdf[gdf["STE_NAME21"] == state_filter]
        log.info("Filtered STE_NAME21==%r: %d -> %d features", state_filter, before, len(gdf))
        if gdf.empty:
            available = sorted(
                set(read_zipped_shapefile(input_zip)["STE_NAME21"].dropna().unique())
            )
            raise ValueError(f"No features for STE_NAME21={state_filter!r}. Available: {available}")

    log.info("Writing GeoParquet intermediate -> %s", output_parquet)
    gdf.to_parquet(output_parquet, compression="zstd")
    log.info(
        "Wrote %.1f MB (%d features)",
        output_parquet.stat().st_size / 1_048_576,
        len(gdf),
    )
    return len(gdf)
