"""SARIMAX-driven bake step for rental / sales / yield forecasts (G1).

T1.3 minimum-viable bake: load rental long-form + CPI from the target
DuckDB, fit `statsforecast.AutoARIMA(season_length=4)` per series with CPI
as exog, drop+recreate the `forecasts` table. Schema is intentionally
shallow — the full DDL (imputation_method, is_nowcast, provenance columns,
etc.) is owned by T4.1; here we write only the columns the T1.3 assertions
exercise plus the AutoARIMA mean / interval columns so downstream tests
in G2 can extend the same write path.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, date, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Literal

import duckdb
import numpy as np
import pandas as pd
from statsforecast import StatsForecast
from statsforecast.models import AutoARIMA

from etl.duckdb_util import compact_duckdb

log = logging.getLogger(__name__)

# `imputation_method` enum (G3/G4 ADR). Paired nowcast_* / forecast_* variants
# label the data-lag-filling path vs. the past-today extrapolation path; the
# latter only appears when --forecast-h > 0 (currently MVP default 0).
ImputationMethod = Literal[
    "observed",
    "nowcast_sarima_cpi",
    "nowcast_sarima_annual",
    "nowcast_yield_bridge_direct",
    "nowcast_yield_bridge_sal_cluster",
    "nowcast_yield_bridge_lga_cluster",
    "nowcast_bedroom_borrowed",
    "nowcast_direct_sarima_low_n",
    "forecast_sarima_cpi",
    "forecast_sarima_annual",
    "forecast_yield_bridge_direct",
    "forecast_yield_bridge_sal_cluster",
    "forecast_yield_bridge_lga_cluster",
    "forecast_bedroom_borrowed",
    "forecast_direct_sarima_low_n",
]

# T4.4 invariant — `provenance_cluster_id` is NULL iff `imputation_method` is
# a direct/observed path, NOT NULL iff it's a cluster-fallback path. The
# `_direct_sarima_low_n` variants (vacant_land sales) and observed rows have
# no provenance cluster either.
_DIRECT_PROVENANCE_METHODS: frozenset[str] = frozenset(
    {
        "observed",
        "nowcast_sarima_cpi",
        "nowcast_sarima_annual",
        "nowcast_yield_bridge_direct",
        "nowcast_bedroom_borrowed",
        "nowcast_direct_sarima_low_n",
        "forecast_sarima_cpi",
        "forecast_sarima_annual",
        "forecast_yield_bridge_direct",
        "forecast_bedroom_borrowed",
        "forecast_direct_sarima_low_n",
    }
)
_CLUSTER_PROVENANCE_METHODS: frozenset[str] = frozenset(
    {
        "nowcast_yield_bridge_sal_cluster",
        "nowcast_yield_bridge_lga_cluster",
        "forecast_yield_bridge_sal_cluster",
        "forecast_yield_bridge_lga_cluster",
    }
)

# Explicit DDL for the `forecasts` table (T4.1). NOT NULL columns enforce the
# G4 ADR invariants — every row must declare its nowcast/forecast kind, its
# CPI-projection status, and how it was imputed. The rest can be NULL today
# and tightened by later G4.x tickets.
# Per-series fitted-model sidecar. Built alongside the `forecasts` table —
# one row per (series_id, model) pair. Carries the AutoARIMA orders +
# goodness-of-fit + coefficients so the analyst surface can show the
# "what's under the hood" panel per region. ARIMA fields are NULL for
# the bedroom-borrowed yield-bridge method (no statistical model behind
# it). `source_class` records whether the INPUT data was vendor-observed
# or one of the four imputed: classes from impute_coverage.py.
_FORECAST_MODELS_DDL = """
CREATE TABLE forecast_models (
    series_id VARCHAR,
    geospatial_codes VARCHAR,
    geospatial_type VARCHAR,
    data_type VARCHAR,
    dwelling_type VARCHAR,
    bedrooms VARCHAR,
    model VARCHAR NOT NULL,
    ar_p INTEGER,
    ar_d INTEGER,
    ar_q INTEGER,
    seasonal_p INTEGER,
    seasonal_d INTEGER,
    seasonal_q INTEGER,
    seasonal_period INTEGER,
    sigma2 DOUBLE,
    aicc DOUBLE,
    n_obs INTEGER,
    coefficients_json VARCHAR,
    exog VARCHAR,
    source_class VARCHAR,
    fit_date DATE
)
"""

_FORECAST_MODEL_COLS: tuple[str, ...] = (
    "series_id",
    "geospatial_codes",
    "geospatial_type",
    "data_type",
    "dwelling_type",
    "bedrooms",
    "model",
    "ar_p",
    "ar_d",
    "ar_q",
    "seasonal_p",
    "seasonal_d",
    "seasonal_q",
    "seasonal_period",
    "sigma2",
    "aicc",
    "n_obs",
    "coefficients_json",
    "exog",
    "source_class",
    "fit_date",
)

_FORECASTS_DDL = """
CREATE TABLE forecasts (
    series_id VARCHAR,
    geospatial_codes VARCHAR,
    geospatial_type VARCHAR,
    data_type VARCHAR,
    dwelling_type VARCHAR,
    bedrooms VARCHAR,
    ds DATE,
    horizon_q INTEGER,
    is_nowcast BOOLEAN NOT NULL,
    cpi_is_projected BOOLEAN NOT NULL,
    y_hat DOUBLE,
    y_hat_lo_80 DOUBLE,
    y_hat_hi_80 DOUBLE,
    y_hat_lo_95 DOUBLE,
    y_hat_hi_95 DOUBLE,
    model VARCHAR,
    fit_date DATE,
    imputation_method VARCHAR NOT NULL,
    provenance_cluster_id VARCHAR
)
"""

# Column ordering matches the DDL — used for the explicit INSERT column list
# so column drift between the two surfaces is impossible.
_FORECAST_COLS: tuple[str, ...] = (
    "series_id",
    "geospatial_codes",
    "geospatial_type",
    "data_type",
    "dwelling_type",
    "bedrooms",
    "ds",
    "horizon_q",
    "is_nowcast",
    "cpi_is_projected",
    "y_hat",
    "y_hat_lo_80",
    "y_hat_hi_80",
    "y_hat_lo_95",
    "y_hat_hi_95",
    "model",
    "fit_date",
    "imputation_method",
    "provenance_cluster_id",
)

_UID_DIMS: tuple[str, ...] = (
    "data_type",
    "geospatial_type",
    "geospatial_codes",
    "dwelling_type",
    "bedrooms",
)

# Sidecar table backing the G3 yield-bridge. T3.1 populates the `suburb_direct`
# source for each (suburb, dwelling) pair where both rental and sales exist at
# the dwelling-level; T3.2 layers `cluster_fallback` rows on top (with non-NULL
# provenance_cluster_id pointing into geographic_hierarchy).
_YIELDS_DDL = """
CREATE TABLE yields (
    geospatial_codes VARCHAR,
    dwelling_type VARCHAR,
    ds DATE,
    annual_rent DOUBLE,
    sale_price DOUBLE,
    gross_yield DOUBLE,
    source VARCHAR,
    provenance_cluster_id VARCHAR
)
"""

_YIELDS_INSERT_DIRECT = """
INSERT INTO yields (
    geospatial_codes, dwelling_type, ds, annual_rent, sale_price,
    gross_yield, source, provenance_cluster_id
)
WITH rental_annual AS (
    -- Per-dwelling annual rent. Real rental data carries the dwelling
    -- breakdown ONLY on per-bedroom rows (house/unit x {1..4 br}); the
    -- per-(suburb, dwelling) rent is the AVG across that dwelling's
    -- bedroom buckets (and quarters) within the year.
    -- `bedrooms <> 'all'` excludes the imputed dwelling-all rollup rows
    -- (docs/specs/impute.md Class A) — those ARE a count-weighted mean of
    -- these same per-bedroom rows, so folding them back in would
    -- double-weight the central tendency.
    SELECT
        geospatial_codes,
        dwelling_type,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year,
        AVG(value) * 52 AS annual_rent
    FROM rental_sales
    WHERE data_type = 'rental' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND dwelling_type IN ('house', 'unit')
      AND bedrooms <> 'all'
      AND value IS NOT NULL
    GROUP BY 1, 2, 3
),
sales_annual AS (
    -- Yields are computed from OBSERVED rental + sales only. The
    -- `source_file NOT LIKE 'imputed:%'` guard excludes the
    -- coverage-matrix imputed sales cells (docs/specs/impute.md Classes
    -- B/C/D) — bootstrapping a yield off an already-imputed sale price
    -- would be imputation-on-imputation.
    SELECT
        geospatial_codes,
        dwelling_type,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year,
        value AS sale_price
    FROM rental_sales
    WHERE data_type = 'sales' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND source_file NOT LIKE 'imputed:%'
      AND value IS NOT NULL
)
SELECT
    -- Key by the SALES single code, not the rental code. ABS rental data
    -- groups SALs ("21966-22757"); sales is per single SAL ("21966"). An
    -- exact-equality join covers only the ~12% of suburbs where rental
    -- happens to be ungrouped. The dash-wrapped LIKE matches a single
    -- sales code inside a (possibly grouped) rental code — '-21966-' is a
    -- substring of '-21966-22757-' but not of '-120031-'. The rental
    -- group's rent is the shared signal for every member suburb.
    s.geospatial_codes,
    s.dwelling_type,
    make_date(s.year, 12, 1) AS ds,
    r.annual_rent,
    s.sale_price,
    r.annual_rent / s.sale_price AS gross_yield,
    'suburb_direct' AS source,
    NULL AS provenance_cluster_id
FROM sales_annual s
INNER JOIN rental_annual r
    ON s.dwelling_type = r.dwelling_type
   AND s.year = r.year
   AND ('-' || r.geospatial_codes || '-') LIKE ('%-' || s.geospatial_codes || '-%')
-- Defensive dedup: if a sales code somehow sits in two rental groupings,
-- keep the most-specific (shortest) rental code.
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY s.geospatial_codes, s.dwelling_type, s.year
    ORDER BY LENGTH(r.geospatial_codes)
) = 1
"""

# G6 forecast_diagnostics — one row per fitted series per backtest pass.
# T6.1 populates `smape` + `n_obs`; the statsmodels-driven columns (Ljung-Box,
# Jarque-Bera, breakvar, AIC) are NULL until the optional v1 path adds them.
_FORECAST_DIAGNOSTICS_DDL = """
CREATE TABLE forecast_diagnostics (
    series_id VARCHAR,
    mape DOUBLE,
    smape DOUBLE,
    ljungbox_p4 DOUBLE,
    ljungbox_p8 DOUBLE,
    jb_p DOUBLE,
    breakvar_p DOUBLE,
    aic DOUBLE,
    n_obs INTEGER
)
"""

# Single-fold holdout horizon for rental backtests — 4 quarters = 1 year.
_SINGLE_FOLD_HOLDOUT_Q = 4

# Cross-tier corroboration table (G6/G8): pairs each LGA's rental against the
# scale-matched SAL cluster median so analysts can spot tier divergence.
_FORECAST_DIAGNOSTICS_CORROBORATION_DDL = """
CREATE TABLE forecast_diagnostics_corroboration (
    lga_code VARCHAR,
    lga_rent DOUBLE,
    sal_cluster_level INTEGER,
    sal_cluster_median_rent DOUBLE,
    divergence_pct DOUBLE
)
"""


# T3.3 — bedroom borrowing. For each rental row with bedrooms != 'all', look up
# the per-(suburb, dwelling) yield and back-derive implied sales:
# `y_hat = rent_per_week * 52 / yield_dwelling`. Interval bounds stay NULL —
# we have no statistical uncertainty estimate for the imputed value yet.
_BEDROOM_BORROW_INSERT = """
INSERT INTO forecasts (
    series_id, geospatial_codes, geospatial_type, data_type,
    dwelling_type, bedrooms, ds, horizon_q,
    is_nowcast, cpi_is_projected,
    y_hat, y_hat_lo_80, y_hat_hi_80, y_hat_lo_95, y_hat_hi_95,
    model, fit_date, imputation_method, provenance_cluster_id
)
WITH bedroom_rental_annual AS (
    -- Per-(suburb, dwelling, bedroom, year) annual rent.
    SELECT
        geospatial_codes,
        geospatial_type,
        dwelling_type,
        bedrooms,
        CAST(strftime('%Y', time_bucket) AS INTEGER) AS year,
        AVG(value) * 52 AS annual_rent
    FROM rental_sales
    WHERE data_type = 'rental' AND geospatial_type = 'suburb'
      AND statistic = 'median'
      AND bedrooms != 'all'
      AND value IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
),
latest_bedroom_rental AS (
    -- Bedroom borrowing is a NOWCAST: one row per (suburb, dwelling,
    -- bedroom) using the most-recent annual rent. The previous query
    -- joined every rental year against every yield year with no year key
    -- — an N x M cartesian blow-up (137k rows / 12 MB artifact on real
    -- data). One nowcast per series is both correct and bounded.
    SELECT geospatial_codes, geospatial_type, dwelling_type, bedrooms, year, annual_rent
    FROM (
        SELECT *, ROW_NUMBER() OVER (
            PARTITION BY geospatial_codes, dwelling_type, bedrooms
            ORDER BY year DESC
        ) AS rk
        FROM bedroom_rental_annual
    )
    WHERE rk = 1
),
latest_yield AS (
    -- Most-recent gross yield per (suburb, dwelling). ARG_MAX picks the
    -- yield value at the latest `ds`.
    SELECT
        geospatial_codes,
        dwelling_type,
        arg_max(gross_yield, ds) AS gross_yield
    FROM yields
    GROUP BY geospatial_codes, dwelling_type
)
SELECT
    -- One sales nowcast per (SALES single code, dwelling, bedroom). The
    -- rental group's per-bedroom rent bridges to every member suburb's
    -- own yield — see the dash-wrapped LIKE rationale in
    -- _YIELDS_INSERT_DIRECT. Output is keyed by y.geospatial_codes (the
    -- single sales code) so the frontend's per-SAL query resolves it.
    'sales|suburb|' || y.geospatial_codes
        || '|' || br.dwelling_type || '|' || br.bedrooms AS series_id,
    y.geospatial_codes,
    'suburb' AS geospatial_type,
    'sales' AS data_type,
    br.dwelling_type,
    br.bedrooms,
    make_date(br.year, 12, 1) AS ds,
    CAST(0 AS INTEGER) AS horizon_q,
    TRUE AS is_nowcast,
    FALSE AS cpi_is_projected,
    br.annual_rent / y.gross_yield AS y_hat,
    NULL AS y_hat_lo_80,
    NULL AS y_hat_hi_80,
    NULL AS y_hat_lo_95,
    NULL AS y_hat_hi_95,
    'bedroom_borrowed' AS model,
    current_date AS fit_date,
    'nowcast_bedroom_borrowed' AS imputation_method,
    NULL AS provenance_cluster_id
FROM latest_bedroom_rental br
INNER JOIN latest_yield y
    ON br.dwelling_type = y.dwelling_type
   AND ('-' || br.geospatial_codes || '-') LIKE ('%-' || y.geospatial_codes || '-%')
-- Gap-fill only. The annual SARIMAX pass above is the primary sales nowcast
-- source; bedroom-borrowed fills (suburb, dwelling, bedroom) cells whose
-- series was too short (< 4 annual obs) to fit AutoARIMA. Skipping series
-- already covered avoids double-counting and keeps the methodology choice
-- transparent in the imputation_method column.
WHERE NOT EXISTS (
    SELECT 1 FROM forecasts f
    WHERE f.series_id = 'sales|suburb|' || y.geospatial_codes
        || '|' || br.dwelling_type || '|' || br.bedrooms
)
-- Defensive dedup: one bedroom-borrowed row per (sales code, dwelling,
-- bedroom), picking the most-specific rental group if a code sits in two.
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY y.geospatial_codes, br.dwelling_type, br.bedrooms
    ORDER BY LENGTH(br.geospatial_codes)
) = 1
"""

_META_LIBS: tuple[str, ...] = ("statsforecast", "duckdb")


def _safe_version(pkg: str) -> str:
    try:
        return version(pkg)
    except PackageNotFoundError:
        return "unknown"


def _write_meta(
    *,
    meta_output: Path,
    seed: int,
    today_at_bake: date,
    cpi_max_date: date,
) -> None:
    """Write provenance JSON for the current bake (T1.4).

    Same shape as the G1 ADR "Cascading implications" note: seed, bake_date,
    today_at_bake, cpi_max_date, library_versions. Re-runs overwrite the file
    (the meta is the only vintage record at MVP — see G1 idempotency ADR).
    """
    payload = {
        "seed": seed,
        "bake_date": datetime.now(UTC).isoformat(),
        "today_at_bake": today_at_bake.isoformat(),
        "cpi_max_date": cpi_max_date.isoformat(),
        "library_versions": {lib: _safe_version(lib) for lib in _META_LIBS},
    }
    meta_output.parent.mkdir(parents=True, exist_ok=True)
    meta_output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def status_row_count(*, output_duckdb: Path) -> int:
    """Return `COUNT(*) FROM forecasts`, or 0 when the table / file is absent.

    Used by `etl forecast status` (T1.2). Pure DuckDB — no side effects beyond
    a read-only connection (DuckDB creates the file on connect if missing,
    which is fine: an empty file still resolves to a zero row count).
    """
    if not output_duckdb.exists():
        return 0
    con = duckdb.connect(str(output_duckdb), read_only=False)
    try:
        exists = con.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_name = 'forecasts'"
        ).fetchone()
        if exists is None:
            return 0
        row = con.execute("SELECT COUNT(*) FROM forecasts").fetchone()
        return int(row[0]) if row else 0
    finally:
        con.close()


def _load_long_frame(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Project `rental_sales` into Nixtla's long format (unique_id, ds, y)."""
    return con.execute(
        """
        SELECT
            data_type || '|' || geospatial_type || '|' || geospatial_codes
              || '|' || dwelling_type || '|' || bedrooms AS unique_id,
            time_bucket AS ds,
            CAST(value AS DOUBLE) AS y
        FROM rental_sales
        WHERE statistic = 'median' AND value IS NOT NULL
        ORDER BY unique_id, ds
        """
    ).fetchdf()


def _load_cpi(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    return con.execute(
        "SELECT time_bucket AS ds, CAST(index_value AS DOUBLE) AS cpi FROM cpi ORDER BY ds"
    ).fetchdf()


def _infer_quarter_freq(ds: pd.Series) -> str:
    """Infer the quarter-START frequency alias from a `ds` column.

    Real ABS data sits on a Mar/Jun/Sep/Dec grid — pandas `QS-DEC` — NOT the
    `QS` (= `QS-JAN`, Jan/Apr/Jul/Oct) default. Passing the wrong anchor to
    StatsForecast shifts every forecast date ~1-2 months off the observed
    grid, which (a) visibly misaligns the chart and (b) breaks the
    single-fold diagnostics merge (forecast `ds` never equals the held-out
    actual `ds`). Infer from the data instead of hardcoding.
    """
    uniq = pd.DatetimeIndex(sorted(pd.to_datetime(pd.Series(ds).dropna().unique())))
    if len(uniq) >= 3:
        inferred = pd.infer_freq(uniq)
        if inferred and inferred.upper().startswith("QS"):
            return inferred.upper()
    # Fallback: a Mar/Jun/Sep/Dec month set is QS-DEC; Jan/Apr/Jul/Oct is QS.
    months = {ts.month for ts in uniq}
    if months <= {3, 6, 9, 12}:
        return "QS-DEC"
    if months <= {2, 5, 8, 11}:
        return "QS-NOV"
    return "QS"


def _project_cpi_forward(cpi: pd.DataFrame, horizon_q: int, freq: str = "QS-DEC") -> pd.DataFrame:
    """Pad CPI forward by up to `horizon_q` quarters with the last known value.

    ABS CPI is released with a one-quarter lag, so on any given bake the
    most recent CPI point is typically one quarter before `today`. A flat
    extrapolation (carry-last) is the conservative choice for the bake
    horizon — quarterly CPI changes are small (<1%) and a wrong forecast
    of CPI propagates to a small wrong forecast of rents/sales, not a
    catastrophic one.

    Returns a CPI frame extending up to (cpi_max_ds + horizon_q quarters).
    """
    if cpi.empty or horizon_q <= 0:
        return cpi
    cpi = cpi.sort_values("ds").reset_index(drop=True)
    last_ds = pd.Timestamp(cpi["ds"].iloc[-1])
    last_value = float(cpi["cpi"].iloc[-1])
    # date_range on the data's own quarter-start grid (`freq`, typically
    # QS-DEC for ABS data) — anchoring to the default QS would shift the
    # padded quarters onto a Jan/Apr/Jul/Oct grid the rest of the pipeline
    # doesn't use.
    future_index = pd.date_range(
        start=last_ds,
        periods=horizon_q + 1,
        freq=freq,
    )[1:]
    padding = pd.DataFrame({"ds": future_index, "cpi": last_value})
    return pd.concat([cpi, padding], ignore_index=True)


def _build_future_exog(train: pd.DataFrame, cpi: pd.DataFrame, horizon_q: int) -> pd.DataFrame:
    """Construct `X_df` — one row per (unique_id, future ds) with CPI exog.

    StatsForecast requires `X_df` to have exactly (n_series x horizon_q)
    rows when X_df is passed alongside h=horizon_q. So we build a uniform
    future grid: for every series, fill `horizon_q` future quarters past
    its own last `ds`. CPI must already be padded forward to cover the
    maximum needed range — callers handle that via `_project_cpi_forward`.
    """
    last_ds = train.groupby("unique_id", as_index=False)["ds"].max()
    future_rows: list[pd.DataFrame] = []
    for uid, last in zip(last_ds["unique_id"], last_ds["ds"], strict=True):
        future_cpi = cpi[cpi["ds"] > last].head(horizon_q).copy()
        future_cpi["unique_id"] = uid
        future_rows.append(future_cpi[["unique_id", "ds", "cpi"]])
    if not future_rows:
        return pd.DataFrame(columns=["unique_id", "ds", "cpi"])
    return pd.concat(future_rows, ignore_index=True)


def _compute_direct_yields(con: duckdb.DuckDBPyConnection) -> None:
    """Compute and persist `(rent * 52) / sale_price` yields per
    (suburb, dwelling) where both rental and sales rows exist (G3 ADR
    "Yield-join strategy" — the `suburb_direct` source).

    Cluster-fallback rows (T3.2) and bedroom-borrowed sales (T3.3) extend the
    bridge without touching the direct path computed here.
    """
    con.execute("DROP TABLE IF EXISTS yields")
    con.execute(_YIELDS_DDL)
    con.execute(_YIELDS_INSERT_DIRECT)


def _compute_corroboration(con: duckdb.DuckDBPyConnection) -> None:
    """Populate `forecast_diagnostics_corroboration`: per-LGA pairing of the
    LGA-tier rental against the scale-matched SAL cluster median rent.

    T8.3 baseline implementation — for each LGA with rental, pairs against
    the most-granular SAL cluster_level that has rental coverage; computes
    `divergence_pct = (sal_median - lga_rent) / lga_rent * 100`. T6.3 will
    refine to per-LGA area-matching later if needed.

    Pre-conditions: `rental_sales` table populated (both `geospatial_type
    ='suburb'` and `='lga'` rows); `geographic_hierarchy` + `cluster_centroids`
    populated by SAL + LGA hierarchy builds.
    """
    con.execute("DROP TABLE IF EXISTS forecast_diagnostics_corroboration")
    con.execute(_FORECAST_DIAGNOSTICS_CORROBORATION_DDL)
    con.execute(
        """
        INSERT INTO forecast_diagnostics_corroboration (
            lga_code, lga_rent, sal_cluster_level,
            sal_cluster_median_rent, divergence_pct
        )
        WITH lga_rentals AS (
            SELECT
                geospatial_codes AS lga_code,
                AVG(value) * 52 AS lga_annual_rent
            FROM rental_sales
            WHERE data_type = 'rental' AND geospatial_type = 'lga'
              AND statistic = 'median'
              AND dwelling_type = 'all' AND bedrooms = 'all'
              AND value IS NOT NULL
            GROUP BY 1
        ),
        sal_annual AS (
            SELECT
                geospatial_codes,
                AVG(value) * 52 AS annual_rent
            FROM rental_sales
            WHERE data_type = 'rental' AND geospatial_type = 'suburb'
              AND statistic = 'median'
              AND dwelling_type = 'all' AND bedrooms = 'all'
              AND value IS NOT NULL
            GROUP BY 1
        ),
        sal_level_medians AS (
            -- Median rental across SAL leaves per cut level.
            SELECT
                gh.cluster_level,
                median(sa.annual_rent) AS sal_median_rent
            FROM geographic_hierarchy gh
            INNER JOIN sal_annual sa ON gh.node_id = sa.geospatial_codes
            WHERE gh.tier = 'sal'
            GROUP BY gh.cluster_level
            HAVING COUNT(*) > 0
        ),
        chosen_level AS (
            -- Pick the most-granular level (highest cluster_level) with
            -- rental coverage. T6.3 may refine to per-LGA area-matching.
            SELECT cluster_level, sal_median_rent
            FROM sal_level_medians
            ORDER BY cluster_level DESC
            LIMIT 1
        )
        SELECT
            lr.lga_code,
            lr.lga_annual_rent AS lga_rent,
            cl.cluster_level AS sal_cluster_level,
            cl.sal_median_rent AS sal_cluster_median_rent,
            (cl.sal_median_rent - lr.lga_annual_rent) / lr.lga_annual_rent * 100.0
                AS divergence_pct
        FROM lga_rentals lr
        CROSS JOIN chosen_level cl
        """
    )


def _compute_sal_cluster_fallback_yields(con: duckdb.DuckDBPyConnection) -> None:
    """For sales-only SALs (sales row exists, no direct yield), find the
    smallest containing SAL cluster with >= 3 rental-bearing siblings and
    write a `source='cluster_fallback'` yield row pointing at that cluster.

    "Smallest cluster" with our cluster_level convention (cut_count) = the
    HIGHEST cluster_level — we walk DESC to take the most specific cluster
    that crosses the threshold. Threshold of 3 per the G3 ADR (lower noise,
    higher fallback coverage tradeoff).

    Pre-conditions: `yields` table exists (call `_compute_direct_yields`
    first); `geographic_hierarchy` and `cluster_centroids` populated by
    `build_sal_hierarchy`.
    """
    # Insert one fallback yield row per sales-only SAL that finds a
    # qualifying cluster. The INSERT-from-SELECT picks the smallest
    # qualifying cluster via ROW_NUMBER() partitioned by SAL.
    con.execute(
        """
        INSERT INTO yields (
            geospatial_codes, dwelling_type, ds, annual_rent,
            sale_price, gross_yield, source, provenance_cluster_id
        )
        WITH sales_orphans AS (
            -- Sales suburbs that have no direct yield row written yet.
            SELECT
                rs.geospatial_codes,
                CAST(strftime('%Y', rs.time_bucket) AS INTEGER) AS year,
                rs.value AS sale_price
            FROM rental_sales rs
            LEFT JOIN yields y
                ON rs.geospatial_codes = y.geospatial_codes
               AND y.source = 'suburb_direct'
            WHERE rs.data_type = 'sales' AND rs.geospatial_type = 'suburb'
              AND rs.statistic = 'median'
              AND rs.source_file NOT LIKE 'imputed:%'
              AND rs.value IS NOT NULL
              AND y.geospatial_codes IS NULL
        ),
        cluster_rent AS (
            -- For each (parent_cluster_id, cluster_level), aggregate the
            -- median annual rent across its rental-bearing members.
            SELECT
                gh.parent_cluster_id,
                gh.cluster_level,
                median(annual.annual_rent) AS cluster_annual_rent,
                COUNT(*) AS n_rental_members
            FROM geographic_hierarchy gh
            INNER JOIN (
                SELECT
                    geospatial_codes,
                    AVG(value) * 52 AS annual_rent
                FROM rental_sales
                WHERE data_type = 'rental' AND geospatial_type = 'suburb'
                  AND statistic = 'median'
                  AND dwelling_type = 'all' AND bedrooms = 'all'
                  AND value IS NOT NULL
                GROUP BY geospatial_codes
            ) annual ON gh.node_id = annual.geospatial_codes
            WHERE gh.tier = 'sal'
            GROUP BY gh.parent_cluster_id, gh.cluster_level
            HAVING COUNT(*) >= 3
        ),
        ranked AS (
            SELECT
                so.geospatial_codes,
                so.year,
                so.sale_price,
                gh.parent_cluster_id AS cluster_id,
                gh.cluster_level,
                cr.cluster_annual_rent,
                -- Highest cluster_level (smallest cluster) first.
                ROW_NUMBER() OVER (
                    PARTITION BY so.geospatial_codes
                    ORDER BY gh.cluster_level DESC
                ) AS rk
            FROM sales_orphans so
            INNER JOIN geographic_hierarchy gh
                ON so.geospatial_codes = gh.node_id
               AND gh.tier = 'sal'
            INNER JOIN cluster_rent cr
                ON gh.parent_cluster_id = cr.parent_cluster_id
               AND gh.cluster_level = cr.cluster_level
        )
        SELECT
            geospatial_codes,
            'all' AS dwelling_type,
            make_date(year, 12, 1) AS ds,
            cluster_annual_rent AS annual_rent,
            sale_price,
            cluster_annual_rent / sale_price AS gross_yield,
            'cluster_fallback' AS source,
            cluster_id AS provenance_cluster_id
        FROM ranked
        WHERE rk = 1
        """
    )


def _compute_bedroom_borrowed_sales(con: duckdb.DuckDBPyConnection) -> None:
    """Back-derive per-bedroom sales y_hat from per-bedroom rental and the
    per-(suburb, dwelling) yield (G3 ADR "Sales granularity — bedroom borrowing").

    Pre-condition: `yields` table is populated (call `_compute_direct_yields`
    first). Output rows carry `imputation_method='nowcast_bedroom_borrowed'`
    and NULL interval bounds (no statistical uncertainty yet).
    """
    exists = con.execute(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_name = 'forecasts'"
    ).fetchone()
    if exists is None:
        con.execute(_FORECASTS_DDL)
    con.execute(_BEDROOM_BORROW_INSERT)


def _compute_single_fold_diagnostics(
    train: pd.DataFrame,
    cpi: pd.DataFrame,
    *,
    holdout_h: int = _SINGLE_FOLD_HOLDOUT_Q,
    n_jobs: int = -1,
) -> pd.DataFrame:
    """Single-fold backtest: hold out the last `holdout_h` quarters per series,
    re-fit AutoARIMA, predict the held-out window, and compute sMAPE.

    Returns one row per series with columns `series_id`, `smape`, `n_obs`.
    Series with fewer than `holdout_h + 1` observations are skipped (no
    meaningful fit possible).
    """
    holdout_chunks: list[pd.DataFrame] = []
    held_in_chunks: list[pd.DataFrame] = []
    for _uid, group in train.groupby("unique_id"):
        if len(group) <= holdout_h:
            continue
        held_in_chunks.append(group.iloc[:-holdout_h])
        holdout_chunks.append(group.iloc[-holdout_h:])

    if not held_in_chunks:
        return pd.DataFrame(columns=["series_id", "smape", "n_obs"])

    held_in = pd.concat(held_in_chunks, ignore_index=True)
    held_out = pd.concat(holdout_chunks, ignore_index=True)
    freq = _infer_quarter_freq(train["ds"])

    # X_df for the holdout window: real CPI exog (no projection — held-out
    # quarters are inside the historical observed range).
    x_df_rows: list[pd.DataFrame] = []
    for uid, group in held_out.groupby("unique_id"):
        future = cpi[cpi["ds"].isin(group["ds"])].copy()
        future["unique_id"] = uid
        x_df_rows.append(future[["unique_id", "ds", "cpi"]])
    x_df = pd.concat(x_df_rows, ignore_index=True) if x_df_rows else None

    sf = StatsForecast(
        models=[AutoARIMA(season_length=4)],
        freq=freq,
        n_jobs=n_jobs,
    )
    fc = sf.forecast(
        df=held_in[["unique_id", "ds", "y", "cpi"]],
        h=holdout_h,
        level=[80, 95],
        X_df=x_df,
    )

    merged = fc[["unique_id", "ds", "AutoARIMA"]].merge(
        held_out[["unique_id", "ds", "y"]],
        on=["unique_id", "ds"],
        how="inner",
    )
    merged["abs_diff"] = (merged["y"] - merged["AutoARIMA"]).abs()
    merged["sym_denom"] = (merged["y"].abs() + merged["AutoARIMA"].abs()) / 2.0
    merged["sym_err"] = merged["abs_diff"] / merged["sym_denom"].replace(0, np.nan)

    diag = (
        merged.groupby("unique_id", as_index=False)["sym_err"]
        .mean()
        .rename(columns={"sym_err": "smape", "unique_id": "series_id"})
    )
    n_obs = (
        held_in.groupby("unique_id", as_index=False)
        .size()
        .rename(columns={"unique_id": "series_id", "size": "n_obs"})
    )
    diag = diag.merge(n_obs, on="series_id", how="inner")
    diag["n_obs"] = diag["n_obs"].astype("int32")
    result: pd.DataFrame = diag[["series_id", "smape", "n_obs"]]
    return result


# Minimum annual observations to fit AutoARIMA on a sales series. AutoARIMA
# can technically run on 3 points but the resulting ARIMA(0,0,0)-mean fit is
# useless; 4 lets it fit AR(1) / MA(1) candidates with at least one degree
# of freedom left for the residual variance.
_SALES_MIN_ANNUAL_OBS = 4

# Cap on how many years of nowcast we'll project for a stale sales series.
# Mirrors the rental STALE_NOWCAST_CAP (16 quarters = 4 years) so a series
# whose last vendor observation is older than 4 years gets dropped rather
# than extrapolated wildly forward.
_SALES_STALE_NOWCAST_CAP_Y = 4


def _annual_nowcast_horizon(sales_long: pd.DataFrame, *, target_year: int) -> pd.Series:
    """Per-series annual horizon in years between last observed ds and
    `target_year`. Caller normally passes
    `max(today.year, _FORECAST_TARGET.year)` so the result covers both the
    nowcast gap (current year vs last vendor observation) and the forward
    forecast target (end of 2026). Series whose last observation already
    sits at-or-past target_year get 0 and produce no rows.
    """
    last_obs = sales_long.groupby("unique_id")["ds"].max()
    last_year = pd.DatetimeIndex(last_obs.values).year
    horizons = np.clip(target_year - last_year, a_min=0, a_max=None)
    return pd.Series(horizons, index=last_obs.index, name="nowcast_h_y")


def _fit_sales_annual(
    sales_long: pd.DataFrame,
    *,
    today: date,
    n_jobs: int,
    target_year: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Fit AutoARIMA on annual sales (`freq='YS'`, `season_length=1`).

    Sales data sits on a Jan-01 grid (one row per calendar year). The bake's
    main path joins CPI's quarterly grid and silently drops every sales row
    because the dates never match — so historically sales went through the
    yield bridge only, and Class C (suburb·all·all) + Class D (LGA·*)
    imputed series with no bedroom-level coverage got zero forecasts.

    This is the missing parallel: split sales out of long_frame, fit
    AutoARIMA without CPI exog (annual CPI smooths to a flat exog that the
    model would overfit), nowcast each series forward to today's calendar
    year. Returns a DataFrame ready for `_insert_forecast_rows` — empty if
    no sales series clears `_SALES_MIN_ANNUAL_OBS`.
    """
    if sales_long.empty:
        return pd.DataFrame(), pd.DataFrame()

    counts = sales_long.groupby("unique_id").size()
    keep_uids = counts[counts >= _SALES_MIN_ANNUAL_OBS].index
    train = sales_long[sales_long["unique_id"].isin(keep_uids)].copy()
    if train.empty:
        log.info(
            "sales SARIMAX: no series with >= %d annual observations",
            _SALES_MIN_ANNUAL_OBS,
        )
        return pd.DataFrame(), pd.DataFrame()

    # Cover whichever is further: today's calendar year (nowcast gap) or
    # the forward forecast target (end of 2026). max() handles "bake runs
    # in 2025 but we want to project through 2026".
    effective_year = max(today.year, target_year)
    nowcast_h = _annual_nowcast_horizon(train, target_year=effective_year)
    # Drop pathologically-stale series — same logic as the rental path's
    # STALE_NOWCAST_CAP. Their last_obs would inflate the global max_h and
    # push every forecast through far-future years where the AR coefficients
    # have no signal.
    stale_uids = nowcast_h[nowcast_h > _SALES_STALE_NOWCAST_CAP_Y].index.tolist()
    if stale_uids:
        log.info(
            "sales SARIMAX: dropping %d stale series (nowcast_h_y > %d)",
            len(stale_uids),
            _SALES_STALE_NOWCAST_CAP_Y,
        )
        train = train[~train["unique_id"].isin(stale_uids)].reset_index(drop=True)
        nowcast_h = nowcast_h.drop(stale_uids)

    max_h = int(nowcast_h.max()) if not nowcast_h.empty else 0
    if max_h == 0:
        log.info("sales SARIMAX: every series already covers today's year")
        return pd.DataFrame(), pd.DataFrame()

    log.info(
        "sales SARIMAX: fitting AutoARIMA on %d annual series x ~%d rows (max h=%d)",
        train["unique_id"].nunique(),
        len(train) // max(train["unique_id"].nunique(), 1),
        max_h,
    )
    sf = StatsForecast(
        models=[AutoARIMA(season_length=1)],
        freq="YS",
        n_jobs=n_jobs,
    )
    # fit() + predict() retain per-series fitted models in sf.fitted_, which
    # _extract_arima_params (called by the bake after this returns) walks to
    # populate the forecast_models sidecar table.
    sf.fit(df=train[["unique_id", "ds", "y"]])
    fc = sf.predict(h=max_h, level=[80, 95])

    # Per-series horizon offset 1..max_h, then trim to each series' own
    # nowcast_h. Mirrors the rental path's surplus-row filter.
    fc["horizon_q"] = (fc.groupby("unique_id").cumcount() + 1).astype("int32")
    per_series_h = nowcast_h.rename("series_total_h")
    fc = fc.merge(per_series_h, left_on="unique_id", right_index=True, how="left")
    fc = fc[fc["horizon_q"] <= fc["series_total_h"]].drop(columns="series_total_h")

    dims = fc["unique_id"].str.split("|", expand=True)
    for i, name in enumerate(_UID_DIMS):
        fc[name] = dims[i]

    fc = fc.rename(
        columns={
            "AutoARIMA": "y_hat",
            "AutoARIMA-lo-80": "y_hat_lo_80",
            "AutoARIMA-hi-80": "y_hat_hi_80",
            "AutoARIMA-lo-95": "y_hat_lo_95",
            "AutoARIMA-hi-95": "y_hat_hi_95",
        }
    )

    # Drop degenerate-interval rows — same filter as the rental path. Annual
    # SARIMAX on short / constant series collapses to zero variance more
    # often than the quarterly path, so this filter does real work here.
    bound_cols = ("y_hat_lo_95", "y_hat_lo_80", "y_hat", "y_hat_hi_80", "y_hat_hi_95")
    bounds = fc[list(bound_cols)].to_numpy()
    nan_mask = np.isnan(bounds).any(axis=1)
    order_ok = np.all(np.diff(bounds, axis=1) >= 0, axis=1)
    bad = nan_mask | ~order_ok
    if bad.any():
        log.info(
            "sales SARIMAX: dropping %d degenerate-interval rows (NaN bounds or lo>hi inversion)",
            int(bad.sum()),
        )
        fc = fc.loc[~bad].reset_index(drop=True)

    fc["series_id"] = fc["unique_id"]
    today_ts = pd.Timestamp(today)
    fc["is_nowcast"] = fc["ds"] <= today_ts
    # No CPI exog on the annual path, so no projected-CPI flag to set.
    fc["cpi_is_projected"] = False
    fc["model"] = "autoarima_annual"
    fc["fit_date"] = today_ts
    fc["imputation_method"] = "nowcast_sarima_annual"
    fc["provenance_cluster_id"] = None
    result: pd.DataFrame = fc
    # Stash the raw fitted-model rows on a typed attribute so the caller
    # can extract them without re-fitting. Returned via a tuple instead of
    # a mutated DataFrame to keep the column set stable for the forecasts
    # INSERT.
    model_raw = _extract_arima_params(sf, model_label="autoarima_annual", exog="none")
    return result, model_raw


# Pyarrow's `arma` order from a fitted AutoARIMA: (p, q, P, Q, s, d, D).
# `s` is the seasonal period (4 for quarterly rental, 1 for annual sales).
# We re-pack into the (p, d, q)(P, D, Q, s) tuple analysts expect.
_ARMA_INDEX = ("p", "q", "P", "Q", "s", "d", "D")


def _extract_arima_params(
    sf: StatsForecast,
    *,
    model_label: str,
    exog: str,
) -> pd.DataFrame:
    """Pull per-series fitted-model rows out of a `StatsForecast.fit(...)`.

    `sf.fitted_` is a (n_series, n_models) ndarray of fitted model objects;
    each AutoARIMA carries its in-sample summary on `.model_` (a dict with
    'arma', 'sigma2', 'aicc', 'nobs', 'coef', etc.). Skips rows where the
    fit collapsed (no `.model_` dict) — those series produced no forecast
    rows either, so omitting their model rows keeps the two tables in sync.
    """
    rows: list[dict[str, Any]] = []
    fitted = getattr(sf, "fitted_", None)
    if fitted is None or fitted.size == 0:
        return pd.DataFrame()
    uids = list(sf.uids)
    for i, uid in enumerate(uids):
        cell = fitted[i, 0]
        m = getattr(cell, "model_", None)
        if not isinstance(m, dict):
            continue
        arma = m.get("arma", (0, 0, 0, 0, 1, 0, 0))
        idx = {k: int(v) for k, v in zip(_ARMA_INDEX, arma, strict=False)}
        coef = m.get("coef", {}) or {}
        coef_json = json.dumps({str(k): float(v) for k, v in coef.items()})
        rows.append(
            {
                "series_id": str(uid),
                "model": model_label,
                "ar_p": idx.get("p", 0),
                "ar_d": idx.get("d", 0),
                "ar_q": idx.get("q", 0),
                "seasonal_p": idx.get("P", 0),
                "seasonal_d": idx.get("D", 0),
                "seasonal_q": idx.get("Q", 0),
                "seasonal_period": idx.get("s", 1),
                "sigma2": float(m.get("sigma2", float("nan"))),
                "aicc": float(m.get("aicc", float("nan"))),
                "n_obs": int(m.get("nobs", 0)),
                "coefficients_json": coef_json,
                "exog": exog,
            }
        )
    return pd.DataFrame(rows)


def _load_source_class(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """One row per series_id: 'observed' if any contributing row in
    rental_sales has a non-imputed source_file, otherwise the imputation
    method prefix (e.g. 'imputed:rollup_rental_dwelling_all').
    """
    return con.execute(
        """
        WITH agg AS (
            SELECT
                data_type || '|' || geospatial_type || '|' || geospatial_codes
                    || '|' || dwelling_type || '|' || bedrooms AS series_id,
                BOOL_AND(source_file LIKE 'imputed:%') AS all_imputed,
                MAX(source_file) FILTER (WHERE source_file LIKE 'imputed:%')
                    AS imp_source
            FROM rental_sales
            WHERE statistic = 'median'
            GROUP BY 1
        )
        SELECT
            series_id,
            CASE WHEN all_imputed THEN imp_source ELSE 'observed' END
                AS source_class
        FROM agg
        """
    ).fetchdf()


def _decorate_model_rows(
    raw: pd.DataFrame, source_class: pd.DataFrame, *, today: date
) -> pd.DataFrame:
    """Augment `_extract_arima_params` output with the dimension columns
    (split from series_id), `source_class` (joined from rental_sales), and
    `fit_date`. Result has every column in _FORECAST_MODEL_COLS.
    """
    if raw.empty:
        return pd.DataFrame(columns=list(_FORECAST_MODEL_COLS))
    dims = raw["series_id"].str.split("|", expand=True)
    out = raw.copy()
    out["data_type"] = dims[0]
    out["geospatial_type"] = dims[1]
    out["geospatial_codes"] = dims[2]
    out["dwelling_type"] = dims[3]
    out["bedrooms"] = dims[4]
    out = out.merge(source_class, on="series_id", how="left")
    out["source_class"] = out["source_class"].fillna("unknown")
    out["fit_date"] = pd.Timestamp(today)
    return out[list(_FORECAST_MODEL_COLS)]


def _insert_model_rows(con: duckdb.DuckDBPyConnection, df: pd.DataFrame, *, alias: str) -> None:
    """Append fitted-model rows into the forecast_models table.

    Pre-condition: the table exists (the rental SARIMAX block CREATE's it
    alongside the forecasts table) and `df` carries every column in
    _FORECAST_MODEL_COLS. NULL ARIMA fields are fine — the schema allows
    them for the bedroom-borrowed rows that lack a statistical fit.
    """
    if df.empty:
        return
    view = f"models_src_{alias}"
    con.register(view, df)
    try:
        col_list = ", ".join(_FORECAST_MODEL_COLS)
        con.execute(
            f"""
            INSERT INTO forecast_models ({col_list})
            SELECT
                series_id,
                geospatial_codes,
                geospatial_type,
                data_type,
                dwelling_type,
                bedrooms,
                model,
                ar_p,
                ar_d,
                ar_q,
                seasonal_p,
                seasonal_d,
                seasonal_q,
                seasonal_period,
                sigma2,
                aicc,
                n_obs,
                coefficients_json,
                exog,
                source_class,
                CAST(fit_date AS DATE) AS fit_date
            FROM {view}
            """
        )
    finally:
        con.unregister(view)


def _insert_forecast_rows(con: duckdb.DuckDBPyConnection, fc: pd.DataFrame, *, alias: str) -> None:
    """Append a prepared forecast DataFrame to the existing forecasts table.

    Pre-condition: the forecasts table exists (the rental SARIMAX flow has
    DROP+CREATE'd it) and `fc` carries every column listed in _FORECAST_COLS.
    `alias` distinguishes the temporary DuckDB view used for the INSERT, so
    multiple call sites in one bake don't collide on view names.
    """
    if fc.empty:
        return
    view = f"fc_src_{alias}"
    con.register(view, fc)
    try:
        col_list = ", ".join(_FORECAST_COLS)
        con.execute(
            f"""
            INSERT INTO forecasts ({col_list})
            SELECT
                series_id,
                geospatial_codes,
                geospatial_type,
                data_type,
                dwelling_type,
                bedrooms,
                CAST(ds AS DATE) AS ds,
                horizon_q,
                is_nowcast,
                cpi_is_projected,
                y_hat,
                y_hat_lo_80,
                y_hat_hi_80,
                y_hat_lo_95,
                y_hat_hi_95,
                model,
                CAST(fit_date AS DATE) AS fit_date,
                imputation_method,
                provenance_cluster_id
            FROM {view}
            """
        )
    finally:
        con.unregister(view)


def _nowcast_horizon_per_series(train: pd.DataFrame, today: date) -> pd.Series:
    """Per-series nowcast horizon in quarters between last observed ds and `today`.

    Returns a Series indexed by `unique_id` whose value is the quarter count
    `today_q.ordinal - last_obs_q.ordinal` (G2 ADR "Horizon framing: nowcast
    horizon"). Series whose last observation already covers today's quarter
    get 0 and produce no nowcast rows.
    """
    today_period = pd.Period(today, freq="Q")
    last_obs = train.groupby("unique_id")["ds"].max()
    last_obs_periods = pd.PeriodIndex(last_obs.values, freq="Q")
    ordinals = np.asarray([p.ordinal for p in last_obs_periods])
    horizons = np.clip(today_period.ordinal - ordinals, a_min=0, a_max=None)
    return pd.Series(horizons, index=last_obs.index, name="nowcast_h")


# All forecast paths extend at least to this date. Quarterly rental rolls
# to the QS-DEC quarter that contains it (2026-12-01); annual sales rolls
# to the calendar year (2026). --forecast-h on the CLI is still honoured as
# an "at-least" override — pass a larger horizon and the bake forecasts
# further, never less than the target.
_FORECAST_TARGET = date(2026, 12, 31)


def run(
    *,
    output_duckdb: Path,
    meta_output: Path | None = None,
    today: date | None = None,
    horizon_q: int = 0,
    n_jobs: int = -1,
    seed: int = 42,
    backtest_mode: str = "single-fold",
) -> int:
    """Bake forecasts into the existing rental_sales DuckDB.

    Per the G2 ADR, horizons split into two pieces:
    - **nowcast horizon** (always on): computed per-series as
      `ceil((today - last_observed) / quarter)`, fills the data-release gap.
    - **forward-forecast horizon** (`horizon_q`): rows past `today`. MVP
      default 0 — production stays nowcast-only and only `/explore` runs
      local forward-forecast experiments.

    `today` defaults to the system clock; pass an explicit `date` to pin it
    (the CLI `--today-iso` flag exposes this for deterministic re-bakes).
    `backtest_mode` is captured for forward-compatibility but only
    `single-fold` is exercised at this ticket.
    """
    _ = backtest_mode  # consumed by G6 (T6.1+); kept on the API surface today
    if today is None:
        today = date.today()
    # Forward horizon: pre-fix this was `max(horizon_q, 0)` and `horizon_q`
    # defaulted to 0 (MVP nowcast-only). User-requested change: every
    # forecast extends at least to _FORECAST_TARGET (end of 2026), so the
    # forward horizon floors at the quarter-gap between today and that
    # target. --forecast-h still overrides upward.
    target_q = pd.Period(_FORECAST_TARGET, freq="Q")
    today_q = pd.Period(today, freq="Q")
    forward_h_target = max(0, target_q.ordinal - today_q.ordinal)
    forward_h = max(horizon_q, forward_h_target)
    log.info(
        "forecast bake: forward_h=%d (target=%s, horizon_q arg=%d)",
        forward_h,
        _FORECAST_TARGET.isoformat(),
        horizon_q,
    )
    np.random.seed(seed)

    log.info("forecast bake: opening %s", output_duckdb)
    con = duckdb.connect(str(output_duckdb))
    try:
        long_frame = _load_long_frame(con)
        if long_frame.empty:
            log.warning("rental_sales has no median rows; writing empty forecasts table")
            con.execute("DROP TABLE IF EXISTS forecasts")
            con.execute(_FORECASTS_DDL)
            return 0

        cpi = _load_cpi(con)
        train = long_frame.merge(cpi, on="ds", how="inner").dropna(subset=["y", "cpi"])

        # Real ABS data sits on a Mar/Jun/Sep/Dec quarter grid (QS-DEC), not
        # the QS default. Infer it once and thread it through every place
        # that generates future dates — StatsForecast, CPI projection — so
        # forecast `ds` values land on the same grid as the observed series.
        freq = _infer_quarter_freq(train["ds"])
        log.info("forecast bake: inferred quarter freq=%s", freq)

        nowcast_h = _nowcast_horizon_per_series(train, today)
        # Drop pathologically-stale series (deprecated codes that haven't seen
        # an update in many years; their `last_obs` would inflate the global
        # max_nowcast_h far past where CPI projection is meaningful). 16
        # quarters = 4 years; well past the structural ~13q sales lag.
        STALE_NOWCAST_CAP = 16
        stale_uids = nowcast_h[nowcast_h > STALE_NOWCAST_CAP].index.tolist()
        if stale_uids:
            log.info(
                "forecast bake: dropping %d stale series (nowcast_h > %d): %s",
                len(stale_uids),
                STALE_NOWCAST_CAP,
                stale_uids[:5] + (["..."] if len(stale_uids) > 5 else []),
            )
            train = train[~train["unique_id"].isin(stale_uids)].reset_index(drop=True)
            nowcast_h = nowcast_h.drop(stale_uids)

        max_nowcast_h = int(nowcast_h.max()) if not nowcast_h.empty else 0
        total_h = max_nowcast_h + forward_h
        log.info(
            "forecast bake: today=%s, max nowcast h=%d, forward h=%d, total h=%d",
            today.isoformat(),
            max_nowcast_h,
            forward_h,
            total_h,
        )
        if total_h == 0:
            log.warning("no nowcast or forward-forecast quarters needed; writing empty forecasts")
            con.execute("DROP TABLE IF EXISTS forecasts")
            con.execute(_FORECASTS_DDL)
            return 0

        # CPI is released with a one-quarter lag; pad it forward with the
        # last known value out to total_h so the exog grid for every series
        # is filled.
        cpi_projected = _project_cpi_forward(cpi, total_h, freq=freq)
        x_df = _build_future_exog(train, cpi_projected, total_h)

        log.info(
            "forecast bake: fitting AutoARIMA on %d series x ~%d rows (horizon_q=%d)",
            train["unique_id"].nunique(),
            len(train) // max(train["unique_id"].nunique(), 1),
            horizon_q,
        )

        sf = StatsForecast(
            models=[AutoARIMA(season_length=4)],
            freq=freq,
            n_jobs=n_jobs,
        )
        # fit() + predict() (over forecast()) so `sf.fitted_` retains the
        # per-series AutoARIMA objects — we extract their (p,d,q)(P,D,Q,s)
        # orders + sigma2 + aicc + coefficients into the forecast_models
        # sidecar table for the explorer's model-details panel.
        sf.fit(df=train[["unique_id", "ds", "y", "cpi"]])
        fc = sf.predict(
            h=total_h,
            level=[80, 95],
            X_df=x_df if not x_df.empty else None,
        )
        rental_model_raw = _extract_arima_params(sf, model_label="autoarima_cpi_q", exog="cpi")

        # Per-series horizon offset 1..total_h, then trim each series down to
        # its own nowcast_h + forward_h rows. StatsForecast fits all series
        # at max(total_h); the surplus rows past each series' boundary are
        # filtered out here.
        fc["horizon_q"] = (fc.groupby("unique_id").cumcount() + 1).astype("int32")
        per_series_total = (nowcast_h + forward_h).rename("series_total_h")
        fc = fc.merge(per_series_total, left_on="unique_id", right_index=True, how="left")
        fc = fc[fc["horizon_q"] <= fc["series_total_h"]].drop(columns="series_total_h")

        dims = fc["unique_id"].str.split("|", expand=True)
        for i, name in enumerate(_UID_DIMS):
            fc[name] = dims[i]

        fc = fc.rename(
            columns={
                "AutoARIMA": "y_hat",
                "AutoARIMA-lo-80": "y_hat_lo_80",
                "AutoARIMA-hi-80": "y_hat_hi_80",
                "AutoARIMA-lo-95": "y_hat_lo_95",
                "AutoARIMA-hi-95": "y_hat_hi_95",
            }
        )

        # Drop rows where AutoARIMA produced degenerate intervals (NaN bounds
        # or inverted ordering — typically a constant-input series where
        # variance collapsed to zero and statsmodels' interval math overflowed).
        # These rows have a meaningless y_hat too; better to omit them than
        # to surface a chart point with no defensible uncertainty.
        bound_cols = ("y_hat_lo_95", "y_hat_lo_80", "y_hat", "y_hat_hi_80", "y_hat_hi_95")
        bounds = fc[list(bound_cols)].to_numpy()
        nan_mask = np.isnan(bounds).any(axis=1)
        order_ok = np.all(np.diff(bounds, axis=1) >= 0, axis=1)
        bad = nan_mask | ~order_ok
        if bad.any():
            log.info(
                "forecast bake: dropping %d degenerate-interval rows (NaN bounds "
                "or lo>hi inversion from collapsed-variance AutoARIMA fits)",
                int(bad.sum()),
            )
            fc = fc.loc[~bad].reset_index(drop=True)

        # T2.2 bake-time post-condition: ordering invariant on the rows we keep.
        # After the degenerate-row drop above this should always pass; failing
        # here means a fresh failure mode that warrants investigation.
        bounds = fc[list(bound_cols)].to_numpy()
        if not np.all(np.diff(bounds, axis=1) >= 0):
            offending_count = int(np.sum(~np.all(np.diff(bounds, axis=1) >= 0, axis=1)))
            raise ValueError(
                f"interval ordering violated on {offending_count} forecast row(s): "
                "expected lo_95 <= lo_80 <= y_hat <= hi_80 <= hi_95"
            )

        # Populate the columns the explicit DDL requires beyond AutoARIMA's
        # native output. Per T4.1 these are placeholders for code paths that
        # land in later tickets (T3.x).
        fc["series_id"] = fc["unique_id"]
        today_ts = pd.Timestamp(today)
        fc["is_nowcast"] = fc["ds"] <= today_ts
        # T2.3: row uses projected CPI iff its ds falls past CPI's last obs.
        # At forward_h=0 with CPI extending to today's quarter, no row trips
        # the projected branch; tickets that bump forward_h > 0 will exercise
        # it once the CPI-projection backfill (G2 ADR) lands.
        cpi_max_ts = pd.Timestamp(cpi["ds"].max())
        fc["cpi_is_projected"] = fc["ds"] > cpi_max_ts
        fc["model"] = "autoarima_cpi_q"
        fc["fit_date"] = pd.Timestamp(today)
        fc["imputation_method"] = "nowcast_sarima_cpi"  # refined by T3.x
        fc["provenance_cluster_id"] = None

        # T4.4 bake-time post-condition: provenance_cluster_id invariant.
        # Direct methods MUST have NULL cluster id; cluster-fallback methods
        # MUST have non-NULL cluster id. Today's bake only produces direct
        # rental rows, so the second direction is vacuously satisfied — the
        # guard is in place for when T3.2 adds cluster-fallback rows.
        method_col = fc["imputation_method"]
        cluster_col = fc["provenance_cluster_id"]
        direct_with_cluster = (
            method_col.isin(_DIRECT_PROVENANCE_METHODS) & cluster_col.notna()
        ).sum()
        cluster_without_id = (
            method_col.isin(_CLUSTER_PROVENANCE_METHODS) & cluster_col.isna()
        ).sum()
        if direct_with_cluster or cluster_without_id:
            raise ValueError(
                f"provenance_cluster_id invariant violated: "
                f"{direct_with_cluster} direct rows have a cluster id, "
                f"{cluster_without_id} cluster-fallback rows are missing one"
            )

        con.register("fc_src", fc)
        con.execute("DROP TABLE IF EXISTS forecasts")
        con.execute(_FORECASTS_DDL)
        # Forecast-models sidecar — built fresh alongside forecasts every
        # bake so the two tables can't drift.
        con.execute("DROP TABLE IF EXISTS forecast_models")
        con.execute(_FORECAST_MODELS_DDL)
        col_list = ", ".join(_FORECAST_COLS)
        con.execute(
            f"""
            INSERT INTO forecasts ({col_list})
            SELECT
                series_id,
                geospatial_codes,
                geospatial_type,
                data_type,
                dwelling_type,
                bedrooms,
                CAST(ds AS DATE) AS ds,
                horizon_q,
                is_nowcast,
                cpi_is_projected,
                y_hat,
                y_hat_lo_80,
                y_hat_hi_80,
                y_hat_lo_95,
                y_hat_hi_95,
                model,
                CAST(fit_date AS DATE) AS fit_date,
                imputation_method,
                provenance_cluster_id
            FROM fc_src
            """
        )
        con.unregister("fc_src")
        log.info("forecast bake: wrote %d rental forecast rows", len(fc))

        # Persist the rental fitted-model rows. source_class is computed
        # once here (then reused for sales + bedroom-borrowed below) so the
        # rental_sales scan is amortised across all three model groups.
        source_class_df = _load_source_class(con)
        rental_models = _decorate_model_rows(rental_model_raw, source_class_df, today=today)
        _insert_model_rows(con, rental_models, alias="rental_arima")
        log.info("forecast bake: wrote %d rental model rows", len(rental_models))

        # Sales SARIMAX (annual). The rental path above merged CPI on `ds`
        # via INNER JOIN, which silently dropped every sales row (annual
        # Jan-01 dates never match quarterly Mar/Jun/Sep/Dec CPI). Pre-fix
        # only bedroom-borrowed produced sales nowcasts — Class C
        # (suburb·all·all) and Class D (LGA·*) imputed series got nothing.
        # Run AutoARIMA directly on the annual series here so every
        # sales series with ≥4 observations gets a real statistical nowcast.
        sales_long = long_frame[long_frame["unique_id"].str.startswith("sales|")].copy()
        sales_fc, sales_model_raw = _fit_sales_annual(
            sales_long,
            today=today,
            n_jobs=n_jobs,
            target_year=_FORECAST_TARGET.year,
        )
        _insert_forecast_rows(con, sales_fc, alias="sales_sarima")
        log.info("forecast bake: wrote %d sales SARIMAX rows", len(sales_fc))
        sales_models = _decorate_model_rows(sales_model_raw, source_class_df, today=today)
        _insert_model_rows(con, sales_models, alias="sales_arima")
        log.info("forecast bake: wrote %d sales model rows", len(sales_models))

        # G3 yield bridge. Sales data is annual and doesn't join CPI's
        # quarterly grid, so sales are NOT forecast by SARIMAX with the CPI
        # exog. Historically the yield bridge was the only sales nowcast
        # path; with the annual SARIMAX above now the primary, bedroom-
        # borrowed becomes a *fallback* for series too short to fit (its
        # `NOT EXISTS` filter skips series_ids already in forecasts).
        # Pre-condition: `geographic_hierarchy` + `cluster_centroids` exist
        # (the Makefile DAG builds them via etl-extract-{sal,lga}-hierarchy
        # before etl-forecast-bake).
        _compute_direct_yields(con)  # `yields` table, source='suburb_direct'
        _compute_sal_cluster_fallback_yields(con)  # adds source='cluster_fallback'
        _compute_bedroom_borrowed_sales(con)  # appends data_type='sales' to `forecasts`
        sales_row = con.execute(
            "SELECT COUNT(*) FROM forecasts WHERE data_type = 'sales'"
        ).fetchone()
        log.info(
            "forecast bake: yield bridge wrote %d sales forecast rows",
            sales_row[0] if sales_row else 0,
        )

        # Bedroom-borrowed model rows: no statistical model, so the ARIMA
        # fields stay NULL. Cribbed straight from the forecasts table for
        # the series ids the bedroom-borrowed insert just produced (those
        # NOT already represented by sales SARIMAX above).
        con.register("source_class_view", source_class_df)
        try:
            bb_inserted = con.execute(
                """
                INSERT INTO forecast_models (
                    series_id, geospatial_codes, geospatial_type, data_type,
                    dwelling_type, bedrooms, model,
                    ar_p, ar_d, ar_q,
                    seasonal_p, seasonal_d, seasonal_q, seasonal_period,
                    sigma2, aicc, n_obs, coefficients_json,
                    exog, source_class, fit_date
                )
                SELECT DISTINCT
                    f.series_id, f.geospatial_codes, f.geospatial_type,
                    f.data_type, f.dwelling_type, f.bedrooms,
                    'bedroom_borrowed' AS model,
                    NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL,
                    'none' AS exog,
                    COALESCE(sc.source_class, 'unknown') AS source_class,
                    CAST(? AS DATE) AS fit_date
                FROM forecasts f
                LEFT JOIN source_class_view sc USING (series_id)
                WHERE f.model = 'bedroom_borrowed'
                  AND NOT EXISTS (
                      SELECT 1 FROM forecast_models fm
                      WHERE fm.series_id = f.series_id
                  )
                """,
                [today],
            ).fetchall()
            _ = bb_inserted  # COUNT comes back via the row-count fetchone next
        finally:
            con.unregister("source_class_view")
        bb_row = con.execute(
            "SELECT COUNT(*) FROM forecast_models WHERE model = 'bedroom_borrowed'"
        ).fetchone()
        log.info(
            "forecast bake: wrote %d bedroom-borrowed model rows",
            bb_row[0] if bb_row else 0,
        )

        # G6/G8 cross-tier corroboration: pair LGA-tier rental against the
        # scale-matched SAL cluster median. Informational diagnostic table.
        _compute_corroboration(con)

        # T6.1: single-fold backtest diagnostics. Drop+recreate per the G1
        # idempotency ADR — diagnostics are a per-bake artifact, not a vintage.
        diag = _compute_single_fold_diagnostics(train, cpi, n_jobs=n_jobs)
        con.execute("DROP TABLE IF EXISTS forecast_diagnostics")
        con.execute(_FORECAST_DIAGNOSTICS_DDL)
        if not diag.empty:
            con.register("diag_src", diag)
            con.execute(
                "INSERT INTO forecast_diagnostics (series_id, smape, n_obs) "
                "SELECT series_id, smape, n_obs FROM diag_src"
            )
            con.unregister("diag_src")
        log.info("forecast bake: wrote %d diagnostic rows", len(diag))

        cpi_max_row = con.execute("SELECT max(time_bucket) FROM cpi").fetchone()
        cpi_max_date = cpi_max_row[0] if cpi_max_row and cpi_max_row[0] else date.today()
    finally:
        con.close()

    # Reclaim page bloat. DuckDB doesn't return freed pages to the OS, so the
    # bake's DROP/CREATE cycles leave the file at a high-water mark well past
    # the live data size. Rewrite into a fresh file and atomically swap back.
    compact_duckdb(output_duckdb)

    if meta_output is not None:
        _write_meta(
            meta_output=meta_output,
            seed=seed,
            today_at_bake=today,
            cpi_max_date=cpi_max_date,
        )
    return 0
