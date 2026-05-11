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
We filter by "polygon's code appears in rental_sales" — covers every
polygon the data layer can render, no more, no less. The filter is
pushed down to parquet's row-group level via pyarrow so we never even
materialise the discarded polygons in memory.

Memory strategy:
The previous implementation loaded the full SAL GeoParquet (~19 MB on
disk, several hundred MB resident with all geometries) and iterated via
`gdf.iterrows()` which keeps the whole DataFrame in the working set the
entire time. On a memory-constrained laptop the combination of geopandas
overhead + h3-py's per-polygon transient bbox expansion at resolution 9
can spike past available RAM and trigger the OOM killer.

This version:
- Reads only `SAL_CODE21` + `geometry` from the parquet (no other cols).
- Pushes the data-coverage filter down to parquet row-group selection,
  so only the 760 data-bearing rows enter memory (vs 2944 total).
- Iterates via `.itertuples()` (lighter than `.iterrows()`).
- Forces `gc.collect()` every BATCH_SIZE polygons so h3-py's transient
  allocations don't accumulate into a runaway heap.
- Logs progress every BATCH_SIZE polygons so the user can see motion.
"""

from __future__ import annotations

import gc
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

# GC + progress-log cadence. 50 polygons strikes a balance between
# release frequency (low enough that h3-py's transient memory can't run
# away) and overhead (gc.collect() isn't free; running it every polygon
# would dominate wall time).
BATCH_SIZE = 50


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


def _cells_from_filtered_gdf(
    gdf: gpd.GeoDataFrame,
    code_col: str,
    resolution: int,
    label: str,
) -> dict[str, str]:
    """Build {h3_cell_id: region_code} for every polygon in `gdf`.

    Caller is responsible for filtering `gdf` to only data-bearing
    polygons before passing it in. This function streams them through
    h3-py one at a time with periodic GC.
    """
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
        log.info("[%s] skipping %d rows with null/empty geometry", label, dropped)

    total = len(valid)
    log.info("[%s] computing H3 cells for %d polygons (resolution=%d)", label, total, resolution)

    # Last-write-wins on cell-id collisions. Polygons are disjoint by
    # construction (boundaries don't overlap), so collisions should be
    # vanishingly rare — they can happen at coastline/water boundaries
    # where adjacent polygons share an H3 cell whose centroid sits on
    # the boundary. Either assignment is acceptable; preserving the last
    # one is just deterministic given iteration order.
    cell_to_code: dict[str, str] = {}
    # Stream rows as plain namedtuples (no DataFrame slice copies).
    for i, row in enumerate(valid[[code_col, "geometry"]].itertuples(index=False), start=1):
        code = str(getattr(row, code_col))
        cells = _geom_to_cells(row.geometry, resolution)
        for cell in cells:
            cell_to_code[cell] = code
        # Drop the intermediate set explicitly so it's collectable on
        # the next gc.collect() rather than waiting for the loop iter
        # to overwrite the name.
        del cells
        if i % BATCH_SIZE == 0:
            gc.collect()
            log.info(
                "[%s]   %d/%d polygons processed, %d cells so far",
                label,
                i,
                total,
                len(cell_to_code),
            )
    gc.collect()
    log.info("[%s] done: %d cells from %d polygons", label, len(cell_to_code), total)
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
    # Aggressively release the temp DataFrame — we don't need it past
    # this point and the next steps will load fresh geometry data.
    del df
    gc.collect()
    return suburb, lga


def _load_sal_subset(sal_parquet: Path, codes: set[str]) -> gpd.GeoDataFrame:
    """Load only the SAL polygons whose SAL_CODE21 appears in `codes`.

    Pushes the filter down to pyarrow's row-group selection so we never
    materialise the discarded polygons in memory. Also restricts column
    read to (SAL_CODE21, geometry) — the parquet has many other columns
    we don't need.
    """
    log.info("Reading SAL parquet (filtered) <- %s", sal_parquet)
    # `filters=` accepts a pyarrow row-group predicate. The list form is
    # an AND across tuples; the single tuple here is the only predicate.
    # `in` filter requires the values as a list (sets unhashable in
    # pyarrow's filter layer).
    gdf = gpd.read_parquet(
        sal_parquet,
        columns=["SAL_CODE21", "geometry"],
        filters=[("SAL_CODE21", "in", list(codes))],
    )
    log.info("Loaded %d SAL polygons (filtered from full set)", len(gdf))
    return gdf


def _load_lga_subset(lga_geojson: Path, codes: set[str]) -> gpd.GeoDataFrame:
    """Load LGA GeoJSON and filter in-memory to data-bearing codes.

    GeoJSON has no row-group filter equivalent, so we read everything
    and filter post-load. The LGA file is only ~80 features so the
    cost is negligible relative to SAL.
    """
    log.info("Reading LGA GeoJSON <- %s", lga_geojson)
    gdf = gpd.read_file(lga_geojson, columns=["LGA_CODE24", "geometry"])
    before = len(gdf)
    gdf = gdf[gdf["LGA_CODE24"].astype(str).isin(codes)].copy()
    log.info("Filtered LGAs to data-bearing codes: %d -> %d features", before, len(gdf))
    return gdf


def _write_cells_json(cells: dict[str, str], output: Path, label: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(cells, separators=(",", ":")), encoding="utf-8")
    log.info(
        "[%s] wrote %s (%.1f KB, %d cells)",
        label,
        output,
        output.stat().st_size / 1024,
        len(cells),
    )


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
    """Emit suburb + LGA H3 cell lookups.

    Each tier is processed-then-released before the next starts so peak
    memory is bounded to whichever tier is heavier (typically SAL).
    """
    suburb_codes, lga_codes = _codes_with_data(rental_sales_parquet)

    # --- SAL (suburb) tier ---
    sal_gdf = _load_sal_subset(sal_parquet, suburb_codes)
    suburb_cells = _cells_from_filtered_gdf(sal_gdf, "SAL_CODE21", sal_resolution, label="SAL")
    # Release the GDF before writing JSON + before LGA tier loads.
    del sal_gdf
    gc.collect()
    _write_cells_json(suburb_cells, suburb_output, label="SAL")
    suburb_count = len(suburb_cells)
    del suburb_cells
    gc.collect()

    # --- LGA tier ---
    lga_gdf = _load_lga_subset(lga_geojson, lga_codes)
    lga_cells = _cells_from_filtered_gdf(lga_gdf, "LGA_CODE24", lga_resolution, label="LGA")
    del lga_gdf
    gc.collect()
    _write_cells_json(lga_cells, lga_output, label="LGA")
    lga_count = len(lga_cells)

    return suburb_count, lga_count
