"""Centralised path constants and defaults for the ETL pipeline.

Mirrors the project rule that env-var / path access goes through one module
(see .claude/rules/python/cli.md and the TS utils/const.ts convention).
"""

from pathlib import Path

# Project root is the parent of this package directory.
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Raw inputs (gitignored — sourced from ABS, PTV, etc.).
ORIGINALS_DIR = PROJECT_ROOT / "data" / "originals"
BOUNDARIES_ORIGINALS = ORIGINALS_DIR / "boundaries"

# Cleaned intermediates (gitignored — derived, can be regenerated).
CONVERTED_DIR = PROJECT_ROOT / "data" / "converted"

# Public served outputs (committed — Vite serves these from /data/...).
PUBLIC_DATA_DIR = PROJECT_ROOT / "public" / "data"

# Output target CRS — Web Mercator-friendly WGS84 (matches Deck.GL/MapLibre).
OUTPUT_CRS = "EPSG:4326"

# Coordinate decimal precision for GeoJSON output. 6 dp ≈ 11 cm at the equator;
# more than enough for suburb polygons, halves file size vs default 15 dp.
GEOJSON_COORD_PRECISION = 6

# Properties to retain on SAL features (per user spec — drop AREASQKM).
SAL_KEEP_PROPERTIES = ("SAL_CODE21", "SAL_NAME21", "STE_CODE21", "STE_NAME21")

# Walking-isochrone source: per-stop GeoJSONs from the upstream isochrones
# project. Each file contains 5/10/15-min contours as separate features.
ISOCHRONES_ORIGINALS = ORIGINALS_DIR / "isochrones"

# Durations we publish as walkability corridors. 10-min is intentionally
# omitted — the user's mental model is "right next to PT" (5) vs. "fine to
# walk to PT" (15); the in-between adds noise without insight.
ISOCHRONE_DURATIONS = (5, 15)

# Properties retained on dissolved isochrone features. The pre-dissolve
# per-stop attributes (STOP_ID, STOP_NAME, source_file, ...) are dropped
# because they're misleading after the union — they describe one arbitrary
# stop within the corridor, not the corridor itself.
ISOCHRONE_KEEP_PROPERTIES = ("minutes", "isochrone_mode")

# PTV (Public Transport Victoria) lines + stops, sourced from the upstream
# isochrones project. Lines are per-route LineStrings; stops are per-stop
# Points enriched with commute-time-to-CBD tiering.
PTV_ORIGINALS = ORIGINALS_DIR / "ptv"
PTV_MODES = ("metro_train", "metro_tram")

# Lines: HEADSIGN repeats LONG_NAME, SHAPE_ID is internal — drop both.
PTV_LINE_KEEP_PROPERTIES = ("SHORT_NAME", "LONG_NAME", "MODE")

# Stops: keep the nearest commute-tier (5/10/15/20+ min to Southern Cross)
# for future color-coding; drop raw distance + raw minutes since the tier
# is the rendering primitive we'll actually use.
PTV_STOP_KEEP_PROPERTIES = (
    "STOP_ID",
    "STOP_NAME",
    "MODE",
    "transit_time_minutes_nearest_tier",
)

# Default Douglas-Peucker tolerance (in EPSG:4326 degrees) for the published
# single-file GeoJSON. ~0.0001° ≈ 11 m at the equator — invisible at suburb
# zoom levels (9-13). Set to 0 to disable simplification.
# Stop-gap until proper LoD/tiling lands; without it the full national SAL
# layer is ~240 MB, well over GitHub's 100 MB hard file-size limit.
SAL_SIMPLIFY_TOLERANCE = 0.0001
