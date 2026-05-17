"""End-to-end tests for the rental/sales forecast bake step (G1, G2, G3)."""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from etl.steps import forecast_rental_sales


def _seed_rental_sales(
    con: duckdb.DuckDBPyConnection,
    *,
    end_date: date | None = None,
    n_obs: int = 100,
    cpi_buffer_q: int = 20,
) -> None:
    """Seed two synthetic rental series of `n_obs` quarters ending at `end_date`.

    Series A and B both follow a CPI-anchored level plus white noise, which
    gives AutoARIMA enough seasonal cycles to fit `season_length=4` without
    degenerating. Frequencies and dimensions mirror the production
    `rental_sales` schema (PRAGMA table_info). Defaults preserve the original
    T1.3 fixture: 100 quarters from 2000-Q1 to 2024-Q4 plus a 20-quarter
    CPI buffer.
    """
    if end_date is None:
        end_date = date(2024, 10, 1)
    rng = np.random.default_rng(seed=42)
    ds = pd.date_range(end=pd.Timestamp(end_date), periods=n_obs, freq="QS")
    cpi_path = 100.0 + np.cumsum(rng.normal(0.4, 0.6, size=len(ds)))

    rows: list[dict[str, object]] = []
    for code, beta, base in (("21001", 0.5, 400.0), ("21002", 0.3, 600.0)):
        y = base + beta * cpi_path + rng.normal(0, 4.0, size=len(ds))
        for t, value in zip(ds, y, strict=True):
            rows.append(
                {
                    "geospatial": f"suburb_{code}",
                    "geospatial_codes": code,
                    "geospatial_type": "suburb",
                    "time_bucket": t.date(),
                    "dwelling_type": "all",
                    "bedrooms": "all",
                    "dwelling_class": "all",
                    "statistic": "median",
                    "value": float(value),
                    "data_type": "rental",
                    "data_frequency": "quarterly",
                    "source_file": "synthetic",
                    "source_sheet": "synthetic",
                    "cell": "synthetic",
                }
            )

    df = pd.DataFrame(rows)
    con.register("rental_src", df)
    con.execute("CREATE TABLE rental_sales AS SELECT * FROM rental_src")
    con.unregister("rental_src")

    # CPI: same historical window + `cpi_buffer_q` forward quarters so the
    # bake has real exog values for the forecast horizon and we don't yet
    # need the univariate CPI-projection path (that's T2.x territory).
    cpi_ds = pd.date_range(start=ds[0], periods=n_obs + cpi_buffer_q, freq="QS")
    cpi_values = 100.0 + np.cumsum(rng.normal(0.4, 0.6, size=len(cpi_ds)))
    cpi_df = pd.DataFrame(
        {
            "region": "Melbourne",
            "time_bucket": cpi_ds.date,
            "index_value": cpi_values,
        }
    )
    con.register("cpi_src", cpi_df)
    con.execute("CREATE TABLE cpi AS SELECT * FROM cpi_src")
    con.unregister("cpi_src")

    _seed_empty_hierarchy(con)


def _seed_empty_hierarchy(con: duckdb.DuckDBPyConnection) -> None:
    """Create empty `geographic_hierarchy` + `cluster_centroids` tables.

    The bake's G3 yield-bridge steps (wired into `run()`) join these tables.
    Production builds them via etl-extract-{sal,lga}-hierarchy before the
    bake; synthetic fixtures seed them empty so the cluster-fallback SQL
    runs (and correctly produces zero fallback rows) instead of erroring on
    a missing table. Rental-only assertions are unaffected.
    """
    con.execute(
        """
        CREATE TABLE geographic_hierarchy (
            node_id VARCHAR, tier VARCHAR, parent_cluster_id VARCHAR,
            cluster_level INTEGER, distance DOUBLE
        )
        """
    )
    con.execute(
        """
        CREATE TABLE cluster_centroids (
            cluster_id VARCHAR, tier VARCHAR, cluster_level INTEGER,
            n_nodes INTEGER, centroid_lat DOUBLE, centroid_lon DOUBLE,
            area_km2 DOUBLE, n_nodes_with_rental INTEGER
        )
        """
    )


def test_bake_writes_forecasts_for_both_synthetic_series(tmp_path: Path) -> None:
    """T1.3 — Synthetic 2-series bake creates a non-empty forecasts table.

    Asserts post-bake row inventory only; interval ordering, CPI flags, and
    schema invariants are downstream tickets (T2.1+, T4.x).
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_sales(con)
    finally:
        con.close()

    forecast_rental_sales.run(
        output_duckdb=db_path,
        horizon_q=4,
        n_jobs=1,
        seed=42,
        backtest_mode="single-fold",
    )

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        distinct_codes = con.execute(
            "SELECT COUNT(DISTINCT geospatial_codes) FROM forecasts"
        ).fetchone()
        assert distinct_codes is not None and distinct_codes[0] == 2, (
            f"expected 2 distinct geospatial_codes, got {distinct_codes}"
        )

        per_series = con.execute(
            "SELECT geospatial_codes, COUNT(*) AS n "
            "FROM forecasts GROUP BY geospatial_codes ORDER BY geospatial_codes"
        ).fetchall()
        assert len(per_series) == 2
        for code, n in per_series:
            assert n > 0, f"series {code!r} got {n} forecast rows (expected > 0)"
    finally:
        con.close()


def test_bake_writes_meta_provenance(tmp_path: Path) -> None:
    """T1.4 — bake writes forecasts_meta.json with required provenance keys.

    Re-runs the bake to confirm `bake_date` mutates between invocations while
    `seed` is preserved — the meta file is the only vintage record at MVP
    (per the G1 ADR; MLFlow owns historical vintaging later).
    """
    db_path = tmp_path / "rental_sales.duckdb"
    meta_path = tmp_path / "forecasts_meta.json"
    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_sales(con)
        cpi_max = con.execute("SELECT max(time_bucket) FROM cpi").fetchone()
        assert cpi_max is not None
        expected_cpi_max = cpi_max[0]
    finally:
        con.close()

    forecast_rental_sales.run(
        output_duckdb=db_path,
        meta_output=meta_path,
        horizon_q=4,
        n_jobs=1,
        seed=42,
        backtest_mode="single-fold",
    )

    assert meta_path.exists(), f"expected meta file at {meta_path}"
    meta1 = json.loads(meta_path.read_text(encoding="utf-8"))

    for key in ("seed", "bake_date", "today_at_bake", "cpi_max_date", "library_versions"):
        assert key in meta1, f"missing required key {key!r} in meta: {meta1}"

    assert meta1["seed"] == 42
    # bake_date / today_at_bake must round-trip as a real timestamp / date.
    datetime.fromisoformat(meta1["bake_date"])
    date.fromisoformat(meta1["today_at_bake"])
    assert meta1["cpi_max_date"] == expected_cpi_max.isoformat()
    assert {"statsforecast", "duckdb"}.issubset(meta1["library_versions"].keys())
    for lib, version in meta1["library_versions"].items():
        assert isinstance(version, str) and version, (
            f"library_versions[{lib!r}] empty: {meta1['library_versions']}"
        )

    forecast_rental_sales.run(
        output_duckdb=db_path,
        meta_output=meta_path,
        horizon_q=4,
        n_jobs=1,
        seed=42,
        backtest_mode="single-fold",
    )
    meta2 = json.loads(meta_path.read_text(encoding="utf-8"))

    assert meta2["seed"] == meta1["seed"], "seed must persist across re-runs"
    assert meta2["bake_date"] != meta1["bake_date"], (
        "bake_date must update on re-run; got identical timestamps"
    )


def test_rental_nowcast_row_count_matches_horizon(tmp_path: Path) -> None:
    """T2.1 — per-series nowcast horizon x N series == post-bake row count.

    Pins `today=2026-05-13` (Q2 2026) and seeds 2 rental series ending Q3 2025
    (3 quarters earlier). The bake must produce exactly N x 3 nowcast rows.
    `--horizon-q` (forward-forecast) is 0 per the G2 MVP ADR.
    """
    pinned_today = date(2026, 5, 13)
    series_end = date(2025, 7, 1)  # Q3 2025: exactly 3 quarters before Q2 2026

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
        count_row = con.execute(
            "SELECT COUNT(*) FROM forecasts WHERE data_type = 'rental' AND is_nowcast"
        ).fetchone()
        assert count_row is not None
        assert count_row[0] == len(input_codes) * 3, (
            f"expected {len(input_codes) * 3} nowcast rows, got {count_row[0]}"
        )

        out_codes = {
            row[0]
            for row in con.execute(
                "SELECT DISTINCT geospatial_codes FROM forecasts "
                "WHERE data_type = 'rental' AND is_nowcast"
            ).fetchall()
        }
        assert out_codes <= input_codes, (
            f"forecasts contains codes not in input: extras={out_codes - input_codes}"
        )
        assert out_codes == input_codes, (
            f"every input code must appear in nowcast output: missing={input_codes - out_codes}"
        )
    finally:
        con.close()


def test_interval_bounds_are_correctly_ordered(tmp_path: Path) -> None:
    """T2.2 — every forecast row satisfies lo95 <= lo80 <= y_hat <= hi80 <= hi95.

    Property holds mathematically for any Gaussian interval around a shared
    point estimate, but the test locks it in as a contract the bake exposes
    to the frontend. The companion bake-time post-condition (added in GREEN)
    catches future refactors that could invert the ordering — e.g. a rename
    swap or a one-off coerce that flips a sign.
    """
    pinned_today = date(2026, 5, 13)
    series_end = date(2025, 7, 1)

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_sales(con, end_date=series_end)
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
        bad_row = con.execute(
            """
            SELECT COUNT(*) FROM forecasts
            WHERE NOT (
                y_hat_lo_95 <= y_hat_lo_80
                AND y_hat_lo_80 <= y_hat
                AND y_hat <= y_hat_hi_80
                AND y_hat_hi_80 <= y_hat_hi_95
            )
            """
        ).fetchone()
    finally:
        con.close()

    assert bad_row is not None and bad_row[0] == 0, (
        f"expected 0 rows with mis-ordered intervals, got {bad_row}"
    )


def test_cpi_is_projected_flag_matches_cpi_window(tmp_path: Path) -> None:
    """T2.3 — cpi_is_projected MUST match `(ds > max(cpi.ds))` on every row.

    Trims the synthetic CPI to end exactly at today's quarter. Pre-extension
    the bake stopped at the nowcast horizon and CPI covered everything, so
    `projected_count` was zero. After extending forecasts to end-of-2026 by
    default, some rows naturally land past CPI's last observation; the
    invariant we still own is the FLAG-LOGIC one — projected iff
    ds > cpi_max — which `violator_count` exercises directly.
    """
    pinned_today = date(2026, 5, 13)
    series_end = date(2025, 7, 1)  # Q3 2025: 3 quarters before today's Q2 2026

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        # cpi_buffer_q=3 → CPI ends at Q2 2026, the same quarter as `today`.
        _seed_rental_sales(con, end_date=series_end, cpi_buffer_q=3)
        cpi_max_row = con.execute("SELECT max(time_bucket) FROM cpi").fetchone()
        assert cpi_max_row is not None
        cpi_max = cpi_max_row[0]
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
        total_rows = con.execute("SELECT COUNT(*) FROM forecasts").fetchone()
        violators = con.execute(
            "SELECT COUNT(*) FROM forecasts WHERE cpi_is_projected != (ds > ?)",
            [cpi_max],
        ).fetchone()
    finally:
        con.close()

    assert total_rows is not None
    assert violators is not None
    total_count = total_rows[0]
    violator_count = violators[0]

    assert total_count > 0, "expected non-empty forecasts table"
    assert violator_count == 0, (
        f"expected cpi_is_projected to match (ds > {cpi_max}) on every row, "
        f"got {violator_count} violators"
    )


def test_cpi_exog_drives_forecast_direction(tmp_path: Path) -> None:
    """T2.4 — adversarial synthetic: +10% future CPI level shift drives y_hat up.

    Constructs rental ≈ β·CPI + N(0, sigma) historically; CPI gets a 10% upward
    shift in the nowcast window. The AutoARIMA(season_length=4) fit with CPI
    as exogenous regressor should propagate the shift, producing
    `y_hat_last > last_observed_y` by >0.5sigma. This exercises the wiring of
    T2.1-T2.3 with no new bake code.
    """
    pinned_today = date(2026, 5, 13)
    series_end = date(2025, 7, 1)  # Q3 2025: 3 quarters before Q2 2026

    rng = np.random.default_rng(seed=2024)
    sigma_noise = 4.0
    beta = 5.0
    base = 200.0
    n_obs = 100

    ds_rental = pd.date_range(end=pd.Timestamp(series_end), periods=n_obs, freq="QS")
    cpi_trend = 100.0 + np.arange(n_obs) * 0.5  # 100, 100.5, ..., 149.5
    rental_y = base + beta * cpi_trend + rng.normal(0, sigma_noise, size=n_obs)

    # CPI extends 10 quarters past rental end, with a +10% level shift on the
    # whole future segment (the nowcast period's exog values).
    cpi_future_h = 10
    ds_cpi = pd.date_range(start=ds_rental[0], periods=n_obs + cpi_future_h, freq="QS")
    cpi_future_trend = cpi_trend[-1] + np.arange(1, cpi_future_h + 1) * 0.5
    cpi_future_shifted = cpi_future_trend * 1.10
    cpi_values = np.concatenate([cpi_trend, cpi_future_shifted])

    rental_rows = [
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": t.date(),
            "dwelling_type": "all",
            "bedrooms": "all",
            "dwelling_class": "all",
            "statistic": "median",
            "value": float(y),
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        }
        for t, y in zip(ds_rental, rental_y, strict=True)
    ]
    cpi_rows = [
        {"region": "Melbourne", "time_bucket": t.date(), "index_value": float(c)}
        for t, c in zip(ds_cpi, cpi_values, strict=True)
    ]

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        rental_df = pd.DataFrame(rental_rows)
        cpi_df = pd.DataFrame(cpi_rows)
        con.register("rental_src", rental_df)
        con.execute("CREATE TABLE rental_sales AS SELECT * FROM rental_src")
        con.unregister("rental_src")
        con.register("cpi_src", cpi_df)
        con.execute("CREATE TABLE cpi AS SELECT * FROM cpi_src")
        con.unregister("cpi_src")
        _seed_empty_hierarchy(con)
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
        y_hat_row = con.execute(
            "SELECT y_hat FROM forecasts WHERE geospatial_codes='TEST' ORDER BY ds DESC LIMIT 1"
        ).fetchone()
    finally:
        con.close()

    assert y_hat_row is not None, "expected at least one forecast row for the test series"
    y_hat_last = float(y_hat_row[0])
    last_observed_y = float(rental_y[-1])

    assert y_hat_last > last_observed_y, (
        f"expected forecast to rise after +10% CPI shift; "
        f"y_hat_last={y_hat_last:.2f}, last_observed={last_observed_y:.2f}"
    )
    threshold = 0.5 * sigma_noise
    assert (y_hat_last - last_observed_y) > threshold, (
        f"expected forecast rise > 0.5sigma={threshold:.2f}; "
        f"got delta={y_hat_last - last_observed_y:.2f}"
    )


def test_bake_is_deterministic_under_seed(tmp_path: Path) -> None:
    """T6.5 — two bake runs with same --seed + --today-iso produce byte-equal
    `forecasts` tables.

    Determinism is load-bearing for the spec's experiment-reproducibility
    story (the meta sidecar names a seed; running the same bake twice must
    produce identical artifacts). Wall-clock-dependent inputs (`now`, etc.)
    must NOT leak into the forecasts row data — `fit_date` uses the pinned
    `today`, never the system clock.
    """
    pinned_today = date(2026, 5, 13)
    series_end = date(2025, 7, 1)

    def _run_bake(path: Path) -> pd.DataFrame:
        con = duckdb.connect(str(path))
        try:
            _seed_rental_sales(con, end_date=series_end)
        finally:
            con.close()

        forecast_rental_sales.run(
            output_duckdb=path,
            today=pinned_today,
            horizon_q=0,
            n_jobs=1,
            seed=42,
            backtest_mode="single-fold",
        )

        con = duckdb.connect(str(path), read_only=True)
        try:
            return con.execute(
                "SELECT * FROM forecasts ORDER BY series_id, ds, horizon_q"
            ).fetchdf()
        finally:
            con.close()

    first = _run_bake(tmp_path / "first.duckdb")
    second = _run_bake(tmp_path / "second.duckdb")

    pd.testing.assert_frame_equal(first, second, check_dtype=True, check_exact=True)
