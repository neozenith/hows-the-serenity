"""Backtest-diagnostics tests for the forecast bake step (G6)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb

from etl.steps import forecast_rental_sales
from etl.tests.test_forecast_rental_sales import _seed_rental_sales


def test_single_fold_writes_smape_per_series(tmp_path: Path) -> None:
    """T6.1 — single-fold bake writes one sMAPE row per fitted rental series.

    Synthetic fixture: 2 rental series, 100 quarters each, ending Q3 2025.
    The bake re-fits with the final 4 quarters held out, computes sMAPE
    between predicted and actual on the held-out window, and stores one row
    per series in `forecast_diagnostics`.
    """
    pinned_today = date(2026, 5, 13)
    series_end = date(2025, 7, 1)

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_sales(con, end_date=series_end)
        input_codes = {
            row[0]
            for row in con.execute("SELECT DISTINCT geospatial_codes FROM rental_sales").fetchall()
        }
    finally:
        con.close()

    forecast_rental_sales.run(
        output_duckdb=db_path,
        today=pinned_today,
        horizon_q=0,
        n_jobs=1,
        seed=42,
        backtest_mode="single-fold",
    )

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        distinct = con.execute(
            "SELECT COUNT(DISTINCT series_id) FROM forecast_diagnostics"
        ).fetchone()
        rows = con.execute(
            "SELECT series_id, smape, n_obs FROM forecast_diagnostics ORDER BY series_id"
        ).fetchall()
    finally:
        con.close()

    assert distinct is not None
    assert distinct[0] == len(input_codes), (
        f"expected {len(input_codes)} distinct diagnostic series, got {distinct[0]}"
    )
    assert len(rows) == len(input_codes)

    for series_id, smape, n_obs in rows:
        assert smape is not None, f"smape missing for {series_id}"
        assert 0.0 <= smape <= 2.0, (
            f"smape {smape} for {series_id} out of [0, 2] — sMAPE bounds violated"
        )
        assert n_obs is not None, f"n_obs missing for {series_id}"
        # Per-series fit used 100 - 4 = 96 observations.
        assert n_obs == 96, (
            f"expected n_obs=96 (100 total - 4 holdout) for {series_id}, got {n_obs}"
        )
