"""Schema-level tests for the forecasts table (G4)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import pytest

from etl.steps import forecast_rental_sales
from etl.tests.test_forecast_rental_sales import _seed_rental_sales

# Column-by-column expectation per the G4 Output(s) DDL. Maps name → (type, NOT NULL).
EXPECTED_FORECAST_COLUMNS: dict[str, tuple[str, bool]] = {
    "series_id": ("VARCHAR", False),
    "geospatial_codes": ("VARCHAR", False),
    "geospatial_type": ("VARCHAR", False),
    "data_type": ("VARCHAR", False),
    "dwelling_type": ("VARCHAR", False),
    "bedrooms": ("VARCHAR", False),
    "ds": ("DATE", False),
    "horizon_q": ("INTEGER", False),
    "is_nowcast": ("BOOLEAN", True),
    "cpi_is_projected": ("BOOLEAN", True),
    "y_hat": ("DOUBLE", False),
    "y_hat_lo_80": ("DOUBLE", False),
    "y_hat_hi_80": ("DOUBLE", False),
    "y_hat_lo_95": ("DOUBLE", False),
    "y_hat_hi_95": ("DOUBLE", False),
    "model": ("VARCHAR", False),
    "fit_date": ("DATE", False),
    "imputation_method": ("VARCHAR", True),
    "provenance_cluster_id": ("VARCHAR", False),
}


def test_forecasts_table_has_explicit_ddl(tmp_path: Path) -> None:
    """T4.1 — explicit DDL + runtime PRAGMA matches the G4 column contract.

    Two-part assertion:
    1. Source-level: `etl/steps/forecast_rental_sales.py` contains a literal
       `CREATE TABLE forecasts` so future authors can `grep` for the schema.
    2. Runtime: after a bake, `PRAGMA table_info(forecasts)` reports every
       column in EXPECTED_FORECAST_COLUMNS with the right type and NOT NULL
       constraint.
    """
    source = Path(forecast_rental_sales.__file__).read_text(encoding="utf-8")
    assert "CREATE TABLE forecasts" in source, (
        "expected an explicit `CREATE TABLE forecasts` DDL in the step source"
    )

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_sales(con)
    finally:
        con.close()

    forecast_rental_sales.run(
        output_duckdb=db_path,
        horizon_q=2,
        n_jobs=1,
        seed=42,
        backtest_mode="single-fold",
    )

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute("PRAGMA table_info(forecasts)").fetchall()
    finally:
        con.close()

    schema: dict[str, tuple[str, bool]] = {row[1]: (row[2], bool(row[3])) for row in rows}
    missing = set(EXPECTED_FORECAST_COLUMNS) - set(schema)
    assert not missing, (
        f"forecasts table is missing required columns: {sorted(missing)}\nactual schema: {schema}"
    )

    for name, (expected_type, expected_notnull) in EXPECTED_FORECAST_COLUMNS.items():
        actual_type, actual_notnull = schema[name]
        assert actual_type.upper() == expected_type, (
            f"{name}: expected type {expected_type}, got {actual_type}"
        )
        assert actual_notnull == expected_notnull, (
            f"{name}: expected NOT NULL={expected_notnull}, got {actual_notnull}"
        )


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_PATH = PROJECT_ROOT / "public" / "data" / "rental_sales.duckdb"
# Ceiling history: 6 MB (rental_sales + cpi only) -> 8 MB (full bake added
# forecasts/yields/hierarchy/corroboration) -> 16 MB (coverage-matrix
# imputation, docs/specs/impute.md). The impute step synthesises the 20
# missing (market, region, dwelling, bedrooms) cells back into
# `rental_sales` so the forecast bake covers the full 36-cell matrix
# instead of 16/36 — that's ~88k+ legitimate derived rows, tagged
# `source_file='imputed:...'` and distinguishable from observations. Each
# raise tracks a real, spec-driven expansion of what the artifact carries,
# not bloat. 16 MB is still a single one-time DuckDB-WASM load (lazy, on
# first suburb click) and the bake's compact_duckdb step keeps it tight.
ARTIFACT_SIZE_CEILING_BYTES = 16 * 1024 * 1024


def test_forecasts_artifact_under_size_ceiling() -> None:
    """T4.3 — committed rental_sales.duckdb must stay under the size ceiling.

    Regression ratchet for the static-file download budget. The artifact ships
    inside the SPA bundle, so a runaway forecasts table would bloat every page
    load. The ceiling is a hard upper bound; see ARTIFACT_SIZE_CEILING_BYTES
    for the rationale behind the current value.
    """
    assert ARTIFACT_PATH.exists(), (
        f"production artifact missing at {ARTIFACT_PATH}; must be committed"
    )
    actual_bytes = ARTIFACT_PATH.stat().st_size
    actual_mb = actual_bytes / (1024 * 1024)
    ceiling_mb = ARTIFACT_SIZE_CEILING_BYTES / (1024 * 1024)
    assert actual_bytes < ARTIFACT_SIZE_CEILING_BYTES, (
        f"rental_sales.duckdb is {actual_mb:.2f} MB, exceeds {ceiling_mb:.0f} MB budget"
    )


def test_provenance_cluster_id_invariants_per_method(tmp_path: Path) -> None:
    """T4.4 — provenance_cluster_id is NULL iff imputation_method is direct.

    Two-direction invariant per the G4 ADR:
    - Direct methods (rental SARIMAX, direct yield, bedroom-borrowed) MUST have
      provenance_cluster_id IS NULL.
    - Cluster-fallback methods (SAL / LGA cluster) MUST have non-NULL ids
      pointing into geographic_hierarchy.

    Today's bake produces only direct rows; the cluster-fallback branch is
    vacuously satisfied until T3.2 lands. The test still locks the contract.
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_sales(con)
    finally:
        con.close()

    forecast_rental_sales.run(
        output_duckdb=db_path,
        today=date(2026, 5, 13),
        horizon_q=0,
        n_jobs=1,
        seed=42,
        backtest_mode="single-fold",
    )

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        direct_violations = con.execute(
            """
            SELECT COUNT(*) FROM forecasts
            WHERE imputation_method IN (
                'observed',
                'nowcast_sarima_cpi',
                'nowcast_yield_bridge_direct',
                'nowcast_bedroom_borrowed'
            )
            AND provenance_cluster_id IS NOT NULL
            """
        ).fetchone()
        cluster_violations = con.execute(
            """
            SELECT COUNT(*) FROM forecasts
            WHERE imputation_method IN (
                'nowcast_yield_bridge_sal_cluster',
                'nowcast_yield_bridge_lga_cluster'
            )
            AND provenance_cluster_id IS NULL
            """
        ).fetchone()
    finally:
        con.close()

    assert direct_violations is not None
    assert cluster_violations is not None
    assert direct_violations[0] == 0, (
        f"direct-method rows must have NULL provenance_cluster_id; "
        f"got {direct_violations[0]} violators"
    )
    assert cluster_violations[0] == 0, (
        f"cluster-fallback rows must have non-NULL provenance_cluster_id; "
        f"got {cluster_violations[0]} violators"
    )


def test_imputation_method_not_null_constraint(tmp_path: Path) -> None:
    """T4.2 — DuckDB rejects inserts with `imputation_method = NULL`.

    Contract test for the NOT NULL invariant declared in T4.1's DDL. Without
    this check, a future "simplification" of the DDL could silently allow
    rows that break the frontend's filter-by-method panel.
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        con.execute(forecast_rental_sales._FORECASTS_DDL)
        # Every NOT NULL column except imputation_method gets a valid value;
        # imputation_method is intentionally NULL to trip the constraint.
        with pytest.raises(duckdb.ConstraintException):
            con.execute(
                """
                INSERT INTO forecasts (
                    is_nowcast, cpi_is_projected, imputation_method
                ) VALUES (TRUE, FALSE, NULL)
                """
            )
    finally:
        con.close()
