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
# isochrones project's full unrestricted snapshots — one combined GeoJSON
# per geometry type, filtered at extract time by the `MODE` column.
PTV_ORIGINALS = ORIGINALS_DIR / "ptv"
PTV_LINES_GEOJSON = PTV_ORIGINALS / "public_transport_lines.geojson"
PTV_STOPS_GEOJSON = PTV_ORIGINALS / "public_transport_stops.geojson"

# Slug -> upstream MODE column value. Slug is what we use in tile dirs and
# the CLI; the MODE value is what's stored in the source GeoJSON properties.
PTV_MODE_LABELS: dict[str, str] = {
    "metro_train": "METRO TRAIN",
    "metro_tram": "METRO TRAM",
    "regional_train": "REGIONAL TRAIN",
}
PTV_MODES = tuple(PTV_MODE_LABELS.keys())

# Lines: HEADSIGN repeats LONG_NAME, SHAPE_ID is internal — drop both.
PTV_LINE_KEEP_PROPERTIES = ("SHORT_NAME", "LONG_NAME", "MODE")

# Stops: just the identifying triplet. The earlier
# `transit_time_minutes_nearest_tier` came from a filtered subset and is not
# present in the unrestricted source — recompute later from a full
# stop-table if commute-tier coloring is wanted.
PTV_STOP_KEEP_PROPERTIES = ("STOP_ID", "STOP_NAME", "MODE")

# Commute-tier hulls: pre-computed concentric polygons radiating from
# Southern Cross at 15/30/45/60-minute commute-time bands. 4 polygons per
# mode, ~3 KB total — too small for MVT tiling, served as static GeoJSON.
PTV_COMMUTE_HULL_KEEP_PROPERTIES = ("MODE", "transit_time_minutes_nearest_tier")

# Rental + sales Excel sources, schema mapping, and outputs.
RENTAL_SALES_INPUT_DIR = ORIGINALS_DIR / "rental_sales"
RENTAL_SALES_SCHEMA = Path(__file__).parent / "rental_sales_schema.yaml"
RENTAL_SALES_PARQUET = CONVERTED_DIR / "rental_sales.parquet"
RENTAL_SALES_DUCKDB = PUBLIC_DATA_DIR / "rental_sales.duckdb"

# Default Douglas-Peucker tolerance (in EPSG:4326 degrees) for the published
# single-file GeoJSON. ~0.0001° ≈ 11 m at the equator — invisible at suburb
# zoom levels (9-13). Set to 0 to disable simplification.
# Stop-gap until proper LoD/tiling lands; without it the full national SAL
# layer is ~240 MB, well over GitHub's 100 MB hard file-size limit.
SAL_SIMPLIFY_TOLERANCE = 0.0001
