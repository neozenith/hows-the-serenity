"""Publish per-region name lookups for the hex-overlay tooltip.

Output shape:
    {
      "<region_code>": "<region_name>",
      ...
    }

SAL_CODE21 -> SAL_NAME21 for the suburb tier; LGA_CODE24 -> LGA_NAME24
for the LGA tier. Trailing "(Vic.)" state qualifiers are stripped so
the displayed names match what users see on signage and in everyday
conversation ("Bayside" not "Bayside (Vic.)").

These lookups are cheap and small (~50 KB each), so we don't bother
with a "only-codes-that-have-rental-data" filter — every polygon in
the source artefact gets a name entry, and the frontend joins by code
to ignore the unused ones.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import geopandas as gpd

log = logging.getLogger("etl.steps.publish_region_names")


def _strip_vic_suffix(name: str) -> str:
    # Mirrors the same `(Vic.)` cleanup done in extract_rental_sales.py for
    # consistency — both sides of the eventual join use the bare name.
    return name.replace(" (Vic.)", "").strip()


def _names_from_gdf(gdf: gpd.GeoDataFrame, code_col: str, name_col: str) -> dict[str, str]:
    if code_col not in gdf.columns or name_col not in gdf.columns:
        raise ValueError(
            f"Source GeoDataFrame missing {code_col!r} or {name_col!r}. "
            f"Available: {[c for c in gdf.columns if c != 'geometry']}"
        )
    return {
        str(row[code_col]): _strip_vic_suffix(str(row[name_col]))
        for _, row in gdf[[code_col, name_col]].iterrows()
    }


def run(
    *,
    sal_parquet: Path,
    lga_geojson: Path,
    suburb_output: Path,
    lga_output: Path,
) -> tuple[int, int]:
    log.info("Reading SAL parquet <- %s", sal_parquet)
    sal_gdf = gpd.read_parquet(sal_parquet)
    suburb_names = _names_from_gdf(sal_gdf, "SAL_CODE21", "SAL_NAME21")
    log.info("Computed %d suburb names", len(suburb_names))

    log.info("Reading LGA GeoJSON <- %s", lga_geojson)
    lga_gdf = gpd.read_file(lga_geojson)
    lga_names = _names_from_gdf(lga_gdf, "LGA_CODE24", "LGA_NAME24")
    log.info("Computed %d LGA names", len(lga_names))

    suburb_output.parent.mkdir(parents=True, exist_ok=True)
    suburb_output.write_text(json.dumps(suburb_names, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote %s (%.1f KB, %d entries)",
        suburb_output,
        suburb_output.stat().st_size / 1024,
        len(suburb_names),
    )

    lga_output.parent.mkdir(parents=True, exist_ok=True)
    lga_output.write_text(json.dumps(lga_names, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote %s (%.1f KB, %d entries)",
        lga_output,
        lga_output.stat().st_size / 1024,
        len(lga_names),
    )

    return len(suburb_names), len(lga_names)
