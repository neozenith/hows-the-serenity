"""Read DataVic school-catchment GeoJSONs into a single normalised GeoParquet.

The source ships one .geojson per (school level, year-level grouping):

  Primary_Integrated_2026.geojson
  Secondary_Integrated_Year7_2026.geojson
  Secondary_Integrated_Year8_2026.geojson
  ...
  Standalone_juniorsec_2026.geojson
  Standalone_seniorsec_2026.geojson
  Standalone_singlesex_2026.geojson

We concatenate them into one GeoDataFrame with a derived `level` column
(parsed from the filename stem) so the downstream tile step can emit one
tile dir per level via a single read.

Source CRS is WGS84/CRS84 (EPSG:4326-compatible); we keep it that way —
the shared tile_layer step reprojects to EPSG:3857 at tile time.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd

log = logging.getLogger("etl.steps.extract_school_zones")

# Properties to keep on each feature. The downstream tile step uses
# the same keep-list when writing MVT properties.
KEEP_PROPERTIES = (
    "School_Name",
    "Campus_Name",
    "ENTITY_CODE",
    "Year_Level",
    "Boundary_Year",
    "level",  # added by this step
)


def parse_level(filename_stem: str) -> str:
    """Derive a short level slug from the source filename.

    Convention (kebab-cased, lowercase, suitable as a tile-dir name):

      Primary_Integrated_2026          -> primary
      Secondary_Integrated_Year7_2026  -> secondary_year7
      Secondary_Integrated_Year10_2026 -> secondary_year10
      Standalone_juniorsec_2026        -> standalone_juniorsec
      Standalone_singlesex_2026        -> standalone_singlesex
    """
    s = filename_stem.lower()
    # Strip the trailing _<year> token. Years are 4 digits.
    s = re.sub(r"_\d{4}$", "", s)
    # Collapse the "_integrated" infix — it's noise across every Primary/Secondary entry.
    s = s.replace("_integrated", "")
    return s


def run(
    *,
    source_dir: Path,
    output_parquet: Path,
) -> int:
    """Read every *.geojson under `source_dir` into one GeoParquet at
    `output_parquet`. Returns the total feature count written.
    """
    if not source_dir.exists():
        raise FileNotFoundError(f"school-zones source dir not found: {source_dir}")
    geojsons = sorted(source_dir.glob("*.geojson"))
    if not geojsons:
        raise FileNotFoundError(f"no *.geojson files in {source_dir}")

    parts: list[gpd.GeoDataFrame] = []
    for p in geojsons:
        log.info("Reading %s", p.name)
        gdf = gpd.read_file(p)
        gdf["level"] = parse_level(p.stem)
        parts.append(gdf)

    merged = gpd.GeoDataFrame(
        pd.concat(parts, ignore_index=True, sort=False),
        crs=parts[0].crs,
    )
    # DataVic ships Boundary_Year as int in some source files and string
    # in others; coerce to a uniform nullable int so arrow/parquet can
    # serialise the merged column without raising at write time.
    if "Boundary_Year" in merged.columns:
        merged["Boundary_Year"] = pd.to_numeric(merged["Boundary_Year"], errors="coerce").astype(
            "Int64"
        )
    log.info(
        "Concatenated %d files -> %d features across %d levels",
        len(parts),
        len(merged),
        merged["level"].nunique(),
    )

    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    merged.to_parquet(output_parquet)
    log.info("Wrote %s (%d rows)", output_parquet, len(merged))
    return len(merged)
