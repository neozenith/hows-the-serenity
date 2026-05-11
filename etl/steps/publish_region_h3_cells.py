"""Publish per-region H3 cell lookups for the rental/sales hex overlay.

For each polygon whose region code appears in the rental_sales dataset,
compute the set of H3 cells whose centroid falls inside it. The frontend
H3HexagonLayer joins these cells against the latest-value-per-region
data from DuckDB and renders one coloured hexagon per cell — producing
a "pixelated map fill" rather than a centroid-binned dot pattern.

Output shape (inverse keyed for fast frontend join):
    {
      "<h3_cell_id>": "<region_code>",
      ...
    }

Why inverse keying: the frontend iterates cells, looks up their region
code, then looks up the value for that code in the active series. The
forward shape {code: [cells]} would force a pre-pass to invert.

Resolution choice:
- SAL (suburb tier) defaults to res 9 (~400m cells). Suburbs are small,
  so even with hundreds of metro suburbs the total cell count stays
  in the tens of thousands.
- LGA tier defaults to res 7 (~1.2 km cells). LGAs are dramatically
  bigger (regional Vic LGAs like Mildura are 22,000 km²) so a finer
  resolution would explode cell count into the millions. Res 7 keeps
  the full-state LGA file at ~50k cells while preserving a visible
  pixelated fill at the LGA viewing scale.

Polygon filter:
The previous metro bbox filter dropped any regional SAL with sales data
and any LGA whose centroid sat outside the bbox. We now filter by
"polygon's code appears in rental_sales", driven from the rental_sales
parquet — covers every polygon the data layer can render, no more, no
less.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import geopandas as gpd
import h3  # type: ignore[import-untyped]  # h3-py ships no stubs / py.typed
import pandas as pd
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.geometry.base import BaseGeometry

log = logging.getLogger("etl.steps.publish_region_h3_cells")

# Per-tier defaults — see module docstring for the reasoning.
SAL_RESOLUTION_DEFAULT = 9
LGA_RESOLUTION_DEFAULT = 7


def _polygon_to_cells(poly: Polygon, resolution: int) -> set[str]:
    """Return H3 cells whose centroid falls inside `poly`."""
    # h3-py v4 takes a GeoJSON-like dict (no LatLngPoly wrapper needed).
    # `geo_to_cells` returns cells whose centroid is inside the polygon —
    # equivalent to the old `polyfill` behaviour.
    return set(h3.geo_to_cells(mapping(poly), resolution))


def _geom_to_cells(geom: BaseGeometry, resolution: int) -> set[str]:
    """Walk Polygon / MultiPolygon and union all covering H3 cells."""
    if isinstance(geom, Polygon):
        return _polygon_to_cells(geom, resolution)
    if isinstance(geom, MultiPolygon):
        cells: set[str] = set()
        for poly in geom.geoms:
            cells |= _polygon_to_cells(poly, resolution)
        return cells
    return set()


def _cells_from_gdf(
    gdf: gpd.GeoDataFrame,
    code_col: str,
    resolution: int,
    codes_with_data: set[str],
) -> dict[str, str]:
    """Build {h3_cell_id: region_code} for every polygon in `codes_with_data`."""
    if gdf.crs is None:
        raise ValueError("Source GeoDataFrame has no CRS")
    if gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    if code_col not in gdf.columns:
        raise ValueError(
            f"Source GeoDataFrame missing {code_col!r}. Available: "
            f"{[c for c in gdf.columns if c != 'geometry']}"
        )

    valid = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    dropped = len(gdf) - len(valid)
    if dropped:
        log.info("Skipping %d rows with null/empty geometry", dropped)

    # Filter polygons to those whose region code appears in the rental_sales
    # data. Anything else has no value to render and would just waste cells.
    before = len(valid)
    valid = valid[valid[code_col].astype(str).isin(codes_with_data)]
    log.info(
        "data-coverage filter (%d codes with data): %d -> %d polygons",
        len(codes_with_data),
        before,
        len(valid),
    )

    # Last-write-wins on cell-id collisions. SAL polygons are disjoint by
    # construction (suburb boundaries don't overlap), so collisions should
    # be vanishingly rare — they can happen at coastline/water boundaries
    # where adjacent polygons share an H3 cell whose centroid sits on the
    # boundary. Either assignment is acceptable; preserving the last one
    # is just deterministic given the iteration order.
    cell_to_code: dict[str, str] = {}
    for _, row in valid.iterrows():
        code = str(row[code_col])
        cells = _geom_to_cells(row.geometry, resolution)
        for cell in cells:
            cell_to_code[cell] = code
    return cell_to_code


def _codes_with_data(
    rental_sales_parquet: Path,
) -> tuple[set[str], set[str]]:
    """Return (suburb_codes, lga_codes) — every region code present in rental_sales."""
    if not rental_sales_parquet.exists():
        raise FileNotFoundError(
            f"rental_sales parquet not found at {rental_sales_parquet}. "
            f"Run `etl extract rental-sales` first."
        )
    log.info("Reading rental_sales parquet <- %s", rental_sales_parquet)
    df = pd.read_parquet(
        rental_sales_parquet,
        columns=["geospatial_type", "geospatial_codes"],
    )
    # `geospatial_codes` is hyphen-joined for multi-region market groups
    # ("20495-22038"). Split and explode so each individual code stands on
    # its own — that's the granularity the polygon filter needs.
    df = df.assign(code=df["geospatial_codes"].astype(str).str.split("-")).explode("code")
    df["code"] = df["code"].str.strip()
    df = df[df["code"].str.len() > 0]
    suburb = set(df.loc[df["geospatial_type"] == "suburb", "code"].unique())
    lga = set(df.loc[df["geospatial_type"] == "lga", "code"].unique())
    log.info(
        "rental_sales coverage: %d unique suburb codes, %d unique LGA codes",
        len(suburb),
        len(lga),
    )
    return suburb, lga


def run(
    *,
    sal_parquet: Path,
    lga_geojson: Path,
    rental_sales_parquet: Path,
    sal_resolution: int = SAL_RESOLUTION_DEFAULT,
    lga_resolution: int = LGA_RESOLUTION_DEFAULT,
    suburb_output: Path,
    lga_output: Path,
) -> tuple[int, int]:
    """Emit suburb + LGA H3 cell lookups. Returns (suburb_cell_count, lga_cell_count)."""
    suburb_codes, lga_codes = _codes_with_data(rental_sales_parquet)

    log.info("Reading SAL parquet <- %s", sal_parquet)
    sal_gdf = gpd.read_parquet(sal_parquet)
    suburb_cells = _cells_from_gdf(sal_gdf, "SAL_CODE21", sal_resolution, suburb_codes)
    log.info("Computed %d suburb H3 cells (resolution=%d)", len(suburb_cells), sal_resolution)

    log.info("Reading LGA GeoJSON <- %s", lga_geojson)
    lga_gdf = gpd.read_file(lga_geojson)
    lga_cells = _cells_from_gdf(lga_gdf, "LGA_CODE24", lga_resolution, lga_codes)
    log.info("Computed %d LGA H3 cells (resolution=%d)", len(lga_cells), lga_resolution)

    suburb_output.parent.mkdir(parents=True, exist_ok=True)
    suburb_output.write_text(json.dumps(suburb_cells, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote %s (%.1f KB, %d cells)",
        suburb_output,
        suburb_output.stat().st_size / 1024,
        len(suburb_cells),
    )

    lga_output.parent.mkdir(parents=True, exist_ok=True)
    lga_output.write_text(json.dumps(lga_cells, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote %s (%.1f KB, %d cells)",
        lga_output,
        lga_output.stat().st_size / 1024,
        len(lga_cells),
    )

    return len(suburb_cells), len(lga_cells)
