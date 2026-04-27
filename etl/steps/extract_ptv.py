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


# Patterns sourced verbatim from the upstream isochrones project's
# `extract_stops_within_union.py` (lines 89, 94) and `utils.py` (line 86).
# Keeping them exactly as the upstream uses them so the substring match
# behaves identically across both pipelines.
_RAIL_REPLACEMENT_LINE_PATTERN = "Replacement Bus"
_RAIL_REPLACEMENT_STOP_PATTERN = "Rail Replacement Bus Stop"


def run(
    *,
    input_geojson: Path,
    output_parquet: Path,
    keep_properties: Iterable[str],
    mode_filter: str | None = None,
    drop_rail_replacement: bool = True,
    dedupe_by: str | None = None,
) -> int:
    """Extract a pruned + optionally MODE-filtered parquet from a PTV GeoJSON.

    `mode_filter` matches against the source's `MODE` column verbatim
    (e.g. "METRO TRAIN", "REGIONAL TRAIN"). Pass None to keep all rows.

    `drop_rail_replacement` (default True) removes rail-replacement-bus
    artifacts that masquerade as train data — lines whose `SHORT_NAME`
    contains "Replacement Bus" and stops whose `STOP_NAME` contains
    "Rail Replacement Bus Stop". These are buses operating during track
    closures; not useful for the affordability/walkability narrative.

    `dedupe_by` (optional column name) collapses duplicate rows via
    `groupby(col).first()` — used for stops where multi-platform records
    repeat the same logical interchange. Match upstream `utils.py:86-90`.
    """
    if not input_geojson.exists():
        raise FileNotFoundError(f"PTV source not found: {input_geojson}")

    log.info("Reading %s", input_geojson)
    gdf = gpd.read_file(input_geojson)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)

    if mode_filter is not None:
        if "MODE" not in gdf.columns:
            raise ValueError(f"mode_filter={mode_filter!r} requested but no MODE column on input")
        before = len(gdf)
        gdf = gdf[gdf["MODE"] == mode_filter]
        log.info("Filtered MODE==%r: %d -> %d features", mode_filter, before, len(gdf))
        if gdf.empty:
            available = sorted(set(gpd.read_file(input_geojson)["MODE"].dropna().unique()))
            raise ValueError(f"No features for MODE={mode_filter!r}. Available: {available}")

    if drop_rail_replacement:
        if "SHORT_NAME" in gdf.columns:
            before = len(gdf)
            gdf = gdf[~gdf["SHORT_NAME"].astype(str).str.contains(_RAIL_REPLACEMENT_LINE_PATTERN)]
            if before != len(gdf):
                log.info("Dropped %d rail-replacement-bus lines", before - len(gdf))
        if "STOP_NAME" in gdf.columns:
            before = len(gdf)
            gdf = gdf[~gdf["STOP_NAME"].astype(str).str.contains(_RAIL_REPLACEMENT_STOP_PATTERN)]
            if before != len(gdf):
                log.info("Dropped %d rail-replacement-bus stops", before - len(gdf))

    if dedupe_by is not None and dedupe_by in gdf.columns:
        before = len(gdf)
        # `as_index=False` so the grouped column stays a regular column.
        # `.first()` keeps the first occurrence's geometry + properties — fine
        # since duplicates are co-located by definition (same physical stop).
        # groupby drops the GeoDataFrame metadata (CRS) on the way out — re-
        # wrap so downstream reprojection still works.
        original_crs = gdf.crs
        deduped = gdf.groupby(dedupe_by, as_index=False).first()
        gdf = gpd.GeoDataFrame(deduped, geometry="geometry", crs=original_crs)
        if before != len(gdf):
            log.info("Deduped by %s: %d -> %d", dedupe_by, before, len(gdf))

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
