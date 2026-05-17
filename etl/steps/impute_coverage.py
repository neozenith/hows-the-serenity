"""Coverage-matrix imputation for `rental_sales` (docs/specs/impute.md).

The vendor feeds populate only 16 of the 36 effective (market, region-type,
dwelling, bedrooms) cells. The other 20 are "missing time series" — see
docs/specs/impute.md for the full audit. This step synthesises those 20
cells from the 16 observed ones and writes them back into the
`rental_sales` parquet + DuckDB table, tagged `source_file='imputed:...'`
so they stay distinguishable from vendor observations.

Recovery classes (impute.md "Empty-cell Causes"). Imputers run in order,
each seeing the prior imputers' output (`working` accumulates):

  A. Rental per-dwelling all-bedrooms rollup (4 cells)
     `rental x {lga,suburb} x {unit,house} x all` — count-weighted mean of
     the per-bedroom children. Rental ships paired count+median rows, so
     the weight is real: all_median = Σ(count_b·median_b) / Σ(count_b).

  C. Sales SAL all-dwellings rollup (1 cell)
     `sales x suburb x all x all` — combine the observed `sales x suburb x
     {unit,house} x all` medians, weighted by the Class-A imputed rental
     dwelling-count mix for the SAL (proxy for the dwelling split).

  B. Sales SAL per-bedroom disaggregation (6 cells)
     `sales x suburb x {unit x {1,2,3}, house x {2,3,4}}` — the vendor
     ships sales only at `bedrooms=all` per dwelling. Split it down using
     the rental per-bedroom ratio as the prior:
       sale_bedroom = sale_all x (rental_bedroom / rental_dwelling_all)

  D. Sales LGA roll-up from SAL (9 cells)
     `sales x lga x *` — the vendor publishes no sales at the LGA tier at
     all. Roll each (now-complete) `sales x suburb x *` cell up to LGA via
     a SAL->LGA spatial crosswalk (SAL representative-point within LGA
     polygon). The roll-up is an equal-weight mean of the member SALs'
     medians — impute.md's ideal is a population-weighted roll-up, but no
     per-SAL population/transaction-count is available in the inputs;
     equal-weight mean of suburb medians is the defensible MVP and is
     documented as such (population-weighting is a future refinement).

Code-keying: rental ships grouped SAL codes ("21966-22757"); sales is per
single SAL ("21966"). Joins use the dash-wrapped LIKE containment trick
('-21966-' is a substring of '-21966-22757-' but not of '-120031-').

The step is idempotent: it strips any prior `source_file LIKE 'imputed%'`
rows before recomputing, so re-running never double-imputes.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb
import geopandas as gpd
import pandas as pd

from etl.duckdb_util import compact_duckdb

log = logging.getLogger(__name__)

# Provenance prefix stamped onto every imputed row's `source_file`. The
# idempotency strip and all downstream "is this observed?" filters key off
# this exact prefix.
IMPUTED_PREFIX = "imputed:"

# --- Class A: rental per-dwelling all-bedrooms rollup ----------------------

# Count-weighted mean of the per-bedroom medians, plus the summed count, for
# every (region, time_bucket, dwelling) where dwelling is unit/house and the
# vendor never ships the bedrooms='all' rollup. Emits BOTH statistic rows
# (median + count) so the imputed cell mirrors the observed rental schema.
_CLASS_A_SQL = """
WITH per_bedroom AS (
    -- One row per (region, time_bucket, dwelling, bedroom) with the paired
    -- count + median pivoted into columns. `dwelling_class` is deliberately
    -- NOT grouped on — in this dataset it's the bedroom-specific composite
    -- ('house-2','house-3',...), so grouping on it would fan the rollup out
    -- to one row per child instead of collapsing the bedroom axis.
    SELECT
        geospatial, geospatial_codes, geospatial_type, time_bucket,
        dwelling_type, bedrooms, data_frequency,
        max(value) FILTER (WHERE statistic = 'median') AS median_val,
        max(value) FILTER (WHERE statistic = 'count')  AS count_val
    FROM working
    WHERE data_type = 'rental'
      AND dwelling_type IN ('unit', 'house')
      AND bedrooms <> 'all'
      AND bedrooms <> '0'
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    HAVING max(value) FILTER (WHERE statistic = 'median') IS NOT NULL
       AND max(value) FILTER (WHERE statistic = 'count')  IS NOT NULL
       AND max(value) FILTER (WHERE statistic = 'count')  > 0
),
rolled AS (
    -- Collapse the bedroom axis: count-weighted mean of the per-bedroom
    -- medians, summed counts. Neither bedrooms nor dwelling_class here.
    SELECT
        geospatial, geospatial_codes, geospatial_type, time_bucket,
        dwelling_type, data_frequency,
        sum(median_val * count_val) / sum(count_val) AS all_median,
        sum(count_val)                               AS all_count
    FROM per_bedroom
    GROUP BY 1, 2, 3, 4, 5, 6
)
SELECT
    geospatial, geospatial_codes, geospatial_type, time_bucket,
    dwelling_type, 'all' AS bedrooms,
    dwelling_type || '-all' AS dwelling_class,
    stat.statistic,
    CASE stat.statistic WHEN 'median' THEN all_median ELSE all_count END AS value,
    'rental' AS data_type, data_frequency,
    'imputed:rollup_rental_dwelling_all' AS source_file,
    'class_a' AS source_sheet,
    '' AS cell
FROM rolled
CROSS JOIN (VALUES ('median'), ('count')) stat(statistic)
"""

# --- Class C: sales SAL all-dwellings rollup -------------------------------

# Combine the observed `sales x suburb x {unit,house} x all` medians into a
# single `all`-dwelling median per (SAL, year). The combine weight is the
# Class-A imputed rental dwelling-count for that SAL/year — a proxy for the
# unit-vs-house dwelling split. `coalesce(weight, 1.0)` degrades to a plain
# mean when no rental weight is available; a SAL with only one dwelling's
# sales just passes that value through.
_CLASS_C_SQL = """
WITH sales_dwelling AS (
    SELECT
        geospatial, geospatial_codes, geospatial_type, time_bucket,
        dwelling_type, value AS sale_price,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year
    FROM working
    WHERE data_type = 'sales' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND dwelling_type IN ('unit', 'house')
      AND bedrooms = 'all'
      AND value IS NOT NULL
),
rental_weight AS (
    -- Class-A imputed rental dwelling-all count, averaged to the year.
    SELECT
        geospatial_codes, dwelling_type,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year,
        avg(value) AS dwelling_count
    FROM working
    WHERE data_type = 'rental' AND geospatial_type = 'suburb'
      AND statistic = 'count'
      AND dwelling_type IN ('unit', 'house')
      AND bedrooms = 'all'
      AND value IS NOT NULL
    GROUP BY 1, 2, 3
),
weighted AS (
    SELECT
        s.geospatial, s.geospatial_codes, s.geospatial_type, s.time_bucket,
        s.dwelling_type, s.sale_price,
        coalesce(rw.dwelling_count, 1.0) AS w
    FROM sales_dwelling s
    LEFT JOIN rental_weight rw
        ON s.dwelling_type = rw.dwelling_type
       AND s.year = rw.year
       AND ('-' || rw.geospatial_codes || '-') LIKE ('%-' || s.geospatial_codes || '-%')
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY s.geospatial_codes, s.dwelling_type, s.time_bucket
        ORDER BY length(rw.geospatial_codes)
    ) = 1
)
SELECT
    geospatial, geospatial_codes, geospatial_type, time_bucket,
    'all' AS dwelling_type, 'all' AS bedrooms, 'all' AS dwelling_class,
    'median' AS statistic,
    sum(sale_price * w) / sum(w) AS value,
    'sales' AS data_type, 'annual' AS data_frequency,
    'imputed:rollup_sales_dwelling_all' AS source_file,
    'class_c' AS source_sheet,
    '' AS cell
FROM weighted
GROUP BY geospatial, geospatial_codes, geospatial_type, time_bucket
"""

# --- Class B: sales SAL per-bedroom disaggregation -------------------------

# The vendor ships sales at `bedrooms=all` per dwelling but never per
# bedroom. Disaggregate using the rental per-bedroom ratio as the prior:
#   sale_bedroom = sale_dwelling_all x (rental_bedroom / rental_dwelling_all)
# Both rental terms are averaged over the sales year's quarters. The rental
# group code is matched to the sales single code via dash-wrapped LIKE.
_CLASS_B_SQL = """
WITH sales_dwelling_all AS (
    SELECT
        geospatial, geospatial_codes, geospatial_type, time_bucket,
        dwelling_type, value AS sale_all,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year
    FROM working
    WHERE data_type = 'sales' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND dwelling_type IN ('unit', 'house')
      AND bedrooms = 'all'
      AND value IS NOT NULL
),
rental_per_bedroom AS (
    SELECT
        geospatial_codes, dwelling_type, bedrooms,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year,
        avg(value) AS rent_bedroom
    FROM working
    WHERE data_type = 'rental' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND dwelling_type IN ('unit', 'house')
      AND bedrooms <> 'all' AND bedrooms <> '0'
      AND value IS NOT NULL
    GROUP BY 1, 2, 3, 4
),
rental_dwelling_all AS (
    -- Class-A imputed per-dwelling all-bedrooms rental median.
    SELECT
        geospatial_codes, dwelling_type,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year,
        avg(value) AS rent_all
    FROM working
    WHERE data_type = 'rental' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND dwelling_type IN ('unit', 'house')
      AND bedrooms = 'all'
      AND value IS NOT NULL
    GROUP BY 1, 2, 3
),
ratios AS (
    SELECT
        rb.geospatial_codes, rb.dwelling_type, rb.bedrooms, rb.year,
        rb.rent_bedroom / ra.rent_all AS ratio
    FROM rental_per_bedroom rb
    INNER JOIN rental_dwelling_all ra
        USING (geospatial_codes, dwelling_type, year)
    WHERE ra.rent_all > 0
),
joined AS (
    SELECT
        s.geospatial, s.geospatial_codes, s.geospatial_type, s.time_bucket,
        s.dwelling_type, r.bedrooms,
        s.sale_all * r.ratio AS sale_bedroom
    FROM sales_dwelling_all s
    INNER JOIN ratios r
        ON s.dwelling_type = r.dwelling_type
       AND s.year = r.year
       AND ('-' || r.geospatial_codes || '-') LIKE ('%-' || s.geospatial_codes || '-%')
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY s.geospatial_codes, s.dwelling_type, r.bedrooms, s.time_bucket
        ORDER BY length(r.geospatial_codes)
    ) = 1
)
SELECT
    geospatial, geospatial_codes, geospatial_type, time_bucket,
    dwelling_type, bedrooms,
    dwelling_type || '-' || bedrooms AS dwelling_class,
    'median' AS statistic,
    sale_bedroom AS value,
    'sales' AS data_type, 'annual' AS data_frequency,
    'imputed:disagg_sales_bedroom' AS source_file,
    'class_b' AS source_sheet,
    '' AS cell
FROM joined
"""

# --- Class D: sales LGA roll-up from SAL -----------------------------------

# Roll every (now-complete after A/C/B) `sales x suburb x *` cell up to the
# LGA tier via the SAL->LGA spatial crosswalk. Equal-weight mean of the
# member SALs' medians — see the module docstring for why equal-weight.
_CLASS_D_SQL = """
WITH sal_sales AS (
    SELECT
        geospatial_codes AS sal_code, time_bucket,
        dwelling_type, bedrooms, dwelling_class,
        value AS sale_price
    FROM working
    WHERE data_type = 'sales' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND value IS NOT NULL
),
lga_rolled AS (
    SELECT
        x.lga_code, x.lga_name, s.time_bucket,
        s.dwelling_type, s.bedrooms,
        any_value(s.dwelling_class) AS dwelling_class,
        avg(s.sale_price) AS lga_price
    FROM sal_sales s
    INNER JOIN sal_lga_crosswalk x ON s.sal_code = x.sal_code
    GROUP BY 1, 2, 3, 4, 5
)
SELECT
    lga_name AS geospatial, lga_code AS geospatial_codes, 'lga' AS geospatial_type,
    time_bucket, dwelling_type, bedrooms, dwelling_class,
    'median' AS statistic, lga_price AS value,
    'sales' AS data_type, 'annual' AS data_frequency,
    'imputed:rollup_sales_lga' AS source_file,
    'class_d' AS source_sheet,
    '' AS cell
FROM lga_rolled
"""

# Imputers run in this order; each sees `working` = observed + everything
# imputed by earlier classes. C and B depend on A's rental dwelling-all
# rows; D depends on B and C having completed the sales-SAL quadrant.
_IMPUTERS: tuple[tuple[str, str], ...] = (
    ("A: rental per-dwelling all-bedrooms rollup", _CLASS_A_SQL),
    ("C: sales SAL all-dwellings rollup", _CLASS_C_SQL),
    ("B: sales SAL per-bedroom disaggregation", _CLASS_B_SQL),
    ("D: sales LGA roll-up from SAL", _CLASS_D_SQL),
)


def _build_sal_lga_crosswalk(sal_parquet: Path, lga_geojson: Path) -> pd.DataFrame:
    """Spatial SAL -> LGA crosswalk: (sal_code, lga_code, lga_name).

    Each SAL's representative point is matched `within` an LGA polygon.
    Class D's roll-up joins sales-SAL rows against this. Raises if the
    geometry inputs are missing — Class D genuinely cannot run without
    knowing which LGA each SAL sits in (no silent skip).
    """
    if not sal_parquet.exists():
        raise FileNotFoundError(f"SAL geometry parquet not found: {sal_parquet}")
    if not lga_geojson.exists():
        raise FileNotFoundError(f"LGA geometry geojson not found: {lga_geojson}")
    sal = gpd.read_parquet(sal_parquet)
    lga = gpd.read_file(lga_geojson)
    sal = sal[sal.geometry.notna()].copy()
    if sal.crs != lga.crs:
        sal = sal.to_crs(lga.crs)
    sal["geometry"] = sal.geometry.representative_point()
    joined = gpd.sjoin(
        sal[["SAL_CODE21", "geometry"]],
        lga[["LGA_CODE24", "LGA_NAME24", "geometry"]],
        how="inner",
        predicate="within",
    )
    crosswalk = pd.DataFrame(
        {
            "sal_code": joined["SAL_CODE21"].astype(str),
            "lga_code": joined["LGA_CODE24"].astype(str),
            "lga_name": joined["LGA_NAME24"].astype(str),
        }
    )
    log.info("impute: SAL->LGA crosswalk built (%d mappings)", len(crosswalk))
    return crosswalk


def _impute_rows(observed: pd.DataFrame, crosswalk: pd.DataFrame) -> pd.DataFrame:
    """Run every recovery class in order; return the union of imputed rows.

    Imputers are threaded: each SELECTs from a `working` view that holds the
    observed rows PLUS everything imputed by earlier classes, so a later
    class (e.g. B) can build on an earlier one's output (e.g. A's rental
    dwelling-all rollup), and D can roll up the sales-SAL quadrant that B+C
    completed. The SAL->LGA `crosswalk` is registered once for Class D.
    Each imputer yields rows in the canonical `rental_sales` column order so
    the result concatenates cleanly.
    """
    cols = list(observed.columns)
    con = duckdb.connect()
    try:
        con.register("sal_lga_crosswalk", crosswalk)
        working = observed.copy()
        chunks: list[pd.DataFrame] = []
        for label, sql in _IMPUTERS:
            con.register("working", working)
            rows = con.execute(sql).fetchdf()[cols]
            con.unregister("working")
            log.info("impute %s -> %d rows", label, len(rows))
            chunks.append(rows)
            working = pd.concat([working, rows], ignore_index=True)
    finally:
        con.close()
    if not chunks:
        return pd.DataFrame(columns=cols)
    return pd.concat(chunks, ignore_index=True)[cols]


def run(
    *,
    input_parquet: Path,
    output_duckdb: Path,
    sal_parquet: Path,
    lga_geojson: Path,
) -> int:
    """Impute the missing coverage-matrix cells back into `rental_sales`.

    Reads the observed parquet, strips any prior imputed rows (idempotency),
    builds the SAL->LGA spatial crosswalk (Class D needs it), appends
    freshly-computed imputed rows, and writes the union back to both the
    parquet (in place — `impute.md`'s reproduction query then shows the
    full matrix) and the `rental_sales` table in `output_duckdb` via
    CREATE OR REPLACE (leaving sibling tables — cpi, hierarchies — intact).
    The DuckDB is compacted afterwards: CREATE-OR-REPLACE on a table this
    large leaves heavy page bloat.

    Returns the number of imputed rows written.
    """
    log.info("impute: reading %s", input_parquet)
    df = pd.read_parquet(input_parquet)

    observed = df[~df["source_file"].astype(str).str.startswith(IMPUTED_PREFIX)].copy()
    stripped = len(df) - len(observed)
    if stripped:
        log.info("impute: stripped %d prior imputed rows (idempotent re-run)", stripped)

    crosswalk = _build_sal_lga_crosswalk(sal_parquet, lga_geojson)
    imputed = _impute_rows(observed, crosswalk)
    log.info("impute: synthesised %d imputed rows", len(imputed))

    combined = pd.concat([observed, imputed], ignore_index=True)
    combined.to_parquet(input_parquet, index=False)
    log.info(
        "impute: wrote %s (%d observed + %d imputed)",
        input_parquet,
        len(observed),
        len(imputed),
    )

    if output_duckdb.exists():
        con = duckdb.connect(str(output_duckdb))
        try:
            con.register("combined_df", combined)
            con.execute("CREATE OR REPLACE TABLE rental_sales AS SELECT * FROM combined_df")
            con.unregister("combined_df")
            log.info("impute: refreshed rental_sales in %s (%d rows)", output_duckdb, len(combined))
        finally:
            con.close()
        # CREATE OR REPLACE on a table this large leaves heavy page bloat —
        # reclaim it so the published artifact stays within budget.
        compact_duckdb(output_duckdb)
    else:
        log.warning("impute: %s missing — parquet updated but DuckDB not refreshed", output_duckdb)

    return len(imputed)
