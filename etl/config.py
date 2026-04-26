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

# Default Douglas-Peucker tolerance (in EPSG:4326 degrees) for the published
# single-file GeoJSON. ~0.0001° ≈ 11 m at the equator — invisible at suburb
# zoom levels (9-13). Set to 0 to disable simplification.
# Stop-gap until proper LoD/tiling lands; without it the full national SAL
# layer is ~240 MB, well over GitHub's 100 MB hard file-size limit.
SAL_SIMPLIFY_TOLERANCE = 0.0001
