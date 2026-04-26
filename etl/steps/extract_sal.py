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


def run(input_zip: Path, output_parquet: Path) -> int:
    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    gdf = read_zipped_shapefile(input_zip)
    log.info("Writing GeoParquet intermediate -> %s", output_parquet)
    gdf.to_parquet(output_parquet, compression="zstd")
    log.info(
        "Wrote %.1f MB (%d features)",
        output_parquet.stat().st_size / 1_048_576,
        len(gdf),
    )
    return len(gdf)
