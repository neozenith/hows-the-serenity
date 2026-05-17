"""Rental-yield-bridge tests for the sales forecast path (G3)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import pandas as pd

from etl.steps import build_sal_hierarchy, forecast_rental_sales
from etl.tests.test_build_sal_hierarchy import _make_grid_sal_parquet


def _seed_minimal_rental_sales_rows(con: duckdb.DuckDBPyConnection) -> None:
    """Insert one per-bedroom rental row and one dwelling-level sales row.

    Mirrors the real `rental_sales` shape: rental carries the dwelling
    breakdown on per-bedroom rows (house/unit x numeric bedrooms), sales
    carries it as (house|unit, bedrooms='all'). The direct yield is
    `AVG(per-bedroom rent) * 52 / sale_price`; with a single bedroom row
    the AVG is just that row.
    """
    rows = [
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": "3",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 500.0,  # weekly rent — *52 = annual_rent
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        },
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": "all",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 520_000.0,  # annual median sale price
            "data_type": "sales",
            "data_frequency": "annual",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        },
    ]
    df = pd.DataFrame(rows)
    con.register("rs_src", df)
    con.execute("CREATE TABLE rental_sales AS SELECT * FROM rs_src")
    con.unregister("rs_src")


def test_direct_yield_math_round_trip(tmp_path: Path) -> None:
    """T3.1 — direct-match yield = (rent * 52) / sale_price.

    rent=500/wk + sale=520_000 → gross_yield = (500 * 52) / 520_000 = 0.05.
    Source label `'suburb_direct'` distinguishes this from the cluster-fallback
    path that arrives in T3.2.
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_minimal_rental_sales_rows(con)
        forecast_rental_sales._compute_direct_yields(con)
        result = con.execute(
            "SELECT gross_yield, source FROM yields WHERE geospatial_codes = 'TEST'"
        ).fetchall()
    finally:
        con.close()

    assert len(result) == 1, f"expected exactly one yield row for TEST, got {result}"
    gross_yield, source = result[0]
    expected = (500.0 * 52.0) / 520_000.0
    assert abs(gross_yield - expected) < 1e-9, (
        f"expected gross_yield ≈ {expected:.12f}, got {gross_yield:.12f}"
    )
    assert source == "suburb_direct", f"expected source='suburb_direct', got {source!r}"


def _seed_bedroom_borrowing_fixture(con: duckdb.DuckDBPyConnection) -> None:
    """Seed rental (house,2br)=400 + (house,3br)=600 + sales(house,all)=520k.

    Per-dwelling yield_house = AVG(400, 600) * 52 / 520_000 = 26_000 / 520_000
    = 0.05 (real rental has no (house, bedrooms='all') row — the per-dwelling
    rent is the mean across the dwelling's bedroom buckets). Bedroom
    borrowing then implies sales_house_3br = (600 * 52) / 0.05 = 624_000.
    """
    rows = [
        # House dwelling, 2-bedroom rent — part of the yield_house mean.
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": "2",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 400.0,
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        },
        # House dwelling, 3-bedroom rent — the bedroom bucket we'll borrow into.
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": "3",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 600.0,
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        },
        # House sales (dwelling-level, no bedrooms split) — denominator of yield.
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": "all",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 520_000.0,
            "data_type": "sales",
            "data_frequency": "annual",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        },
    ]
    df = pd.DataFrame(rows)
    con.register("rs_src", df)
    con.execute("CREATE TABLE rental_sales AS SELECT * FROM rs_src")
    con.unregister("rs_src")


def test_bedroom_borrowed_sales_row_uses_dwelling_yield(tmp_path: Path) -> None:
    """T3.3 — (house, 3br) sales y_hat ≈ (rent_3br * 52) / yield_house.

    Yield bridges rental's per-bedroom granularity onto sales' dwelling-only
    granularity. The output row carries imputation_method='nowcast_bedroom_borrowed'
    so the frontend can render it with the "imputed" visual treatment.
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_bedroom_borrowing_fixture(con)
        forecast_rental_sales._compute_direct_yields(con)
        forecast_rental_sales._compute_bedroom_borrowed_sales(con)
        result = con.execute(
            """
            SELECT y_hat, imputation_method
            FROM forecasts
            WHERE geospatial_codes = 'TEST'
              AND data_type = 'sales'
              AND dwelling_type = 'house'
              AND bedrooms = '3'
            """
        ).fetchall()
    finally:
        con.close()

    assert len(result) == 1, f"expected exactly one (TEST, house, 3) sales row, got {result}"
    y_hat, imputation_method = result[0]
    expected = (600.0 * 52.0) / 0.05  # 624_000 — yield_house = AVG(400,600)*52/520k
    assert abs(y_hat - expected) < 1e-6, f"expected y_hat ≈ {expected:.6f}, got {y_hat:.6f}"
    assert imputation_method == "nowcast_bedroom_borrowed", (
        f"expected imputation_method='nowcast_bedroom_borrowed', got {imputation_method!r}"
    )


def _seed_rental_for_codes(con: duckdb.DuckDBPyConnection, codes: list[str]) -> None:
    """Append rental_all_all rows for each code (rent=500/wk, year 2023)."""
    rows = [
        {
            "geospatial": f"suburb_{c}",
            "geospatial_codes": c,
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "all",
            "bedrooms": "all",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 500.0,
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        }
        for c in codes
    ]
    df = pd.DataFrame(rows)
    con.register("seed_src", df)
    exists = con.execute(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_name = 'rental_sales'"
    ).fetchone()
    if exists is None:
        con.execute("CREATE TABLE rental_sales AS SELECT * FROM seed_src")
    else:
        con.execute("INSERT INTO rental_sales SELECT * FROM seed_src")
    con.unregister("seed_src")


def _seed_sales_for_code(con: duckdb.DuckDBPyConnection, code: str, price: float) -> None:
    """Append one sales_all row for `code` at the given price (year 2023)."""
    df = pd.DataFrame(
        [
            {
                "geospatial": f"suburb_{code}",
                "geospatial_codes": code,
                "geospatial_type": "suburb",
                "time_bucket": date(2023, 6, 1),
                "dwelling_type": "all",
                "bedrooms": "all",
                "dwelling_class": "all",
                "statistic": "median",
                "value": price,
                "data_type": "sales",
                "data_frequency": "annual",
                "source_file": "synthetic",
                "source_sheet": "synthetic",
                "cell": "synthetic",
            }
        ]
    )
    con.register("seed_src", df)
    con.execute("INSERT INTO rental_sales SELECT * FROM seed_src")
    con.unregister("seed_src")


def test_sal_cluster_fallback_records_provenance(tmp_path: Path) -> None:
    """T3.2 — sales-only SAL with no direct rental gets a cluster-fallback yield row.

    Fixture: 5x5 SAL grid; 12 SALs (20001..20012) have rental_all_all=500/wk;
    SAL 20013 has sales_all=520_000 only. After build_sal_hierarchy + direct
    + cluster-fallback yield computation, 20013 should have a yield row
    with source='cluster_fallback' and provenance_cluster_id matching a
    cluster_centroids row at `tier='sal'`.
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    _make_grid_sal_parquet(sal_parquet)

    db_path = tmp_path / "rental_sales.duckdb"
    unfunded_sales_code = "20013"
    # Seed rentals for every SAL EXCEPT the unfunded one — guarantees the
    # smallest containing cluster has >=3 rental-bearing siblings.
    rental_codes = [str(c) for c in range(20_001, 20_026) if str(c) != unfunded_sales_code]

    con = duckdb.connect(str(db_path))
    try:
        _seed_rental_for_codes(con, rental_codes)
        _seed_sales_for_code(con, unfunded_sales_code, 520_000.0)
    finally:
        con.close()

    # Build the SAL hierarchy so geographic_hierarchy + cluster_centroids exist.
    ts_models = tmp_path / "ts_models.duckdb"
    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=db_path,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )

    con = duckdb.connect(str(db_path))
    try:
        forecast_rental_sales._compute_direct_yields(con)
        forecast_rental_sales._compute_sal_cluster_fallback_yields(con)

        # The unfunded suburb gets a cluster_fallback yield row.
        fallback = con.execute(
            """
            SELECT y.gross_yield, y.source, y.provenance_cluster_id
            FROM yields y
            WHERE y.geospatial_codes = ?
              AND y.source = 'cluster_fallback'
            """,
            [unfunded_sales_code],
        ).fetchall()
        # provenance_cluster_id must resolve into cluster_centroids at tier='sal'.
        if fallback:
            _gy, _src, cluster_id = fallback[0]
            centroid_match = con.execute(
                "SELECT COUNT(*) FROM cluster_centroids WHERE cluster_id = ? AND tier = 'sal'",
                [cluster_id],
            ).fetchone()
        else:
            centroid_match = None
    finally:
        con.close()

    assert len(fallback) == 1, (
        f"expected exactly one cluster_fallback yield row for {unfunded_sales_code}, got {fallback}"
    )
    _gy, source, cluster_id = fallback[0]
    assert source == "cluster_fallback"
    assert cluster_id is not None, "provenance_cluster_id must be non-NULL on fallback rows"
    assert centroid_match is not None and centroid_match[0] == 1, (
        f"provenance_cluster_id {cluster_id!r} did not resolve to a "
        f"cluster_centroids row with tier='sal'"
    )


def _seed_multi_bedroom_fixture(con: duckdb.DuckDBPyConnection) -> int:
    """Seed rental at (house, 3), (house, 4) + sales(house, all).

    Mirrors real data: there is no (house, bedrooms='all') rental row — the
    per-dwelling yield is derived by averaging the bedroom-specific rows.
    Returns the count of bedroom-specific rental rows seeded (rows with
    bedrooms != 'all') — that's the count of bedroom-borrowed forecast rows
    T3.4 expects to see post-bake.
    """
    bedroom_specific_rows = [
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": br,
            "dwelling_class": "all",
            "statistic": "median",
            "value": value,
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        }
        for br, value in [("3", 600.0), ("4", 700.0)]
    ]
    yield_inputs = [
        # sales_house at suburb level — the per-dwelling yield is computed
        # against the AVG of the bedroom-specific rental rows above.
        {
            "geospatial": "test_suburb",
            "geospatial_codes": "TEST",
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 6, 1),
            "dwelling_type": "house",
            "bedrooms": "all",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 520_000.0,
            "data_type": "sales",
            "data_frequency": "annual",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        },
    ]
    df = pd.DataFrame(bedroom_specific_rows + yield_inputs)
    con.register("rs_src", df)
    con.execute("CREATE TABLE rental_sales AS SELECT * FROM rs_src")
    con.unregister("rs_src")
    return len(bedroom_specific_rows)


def test_imputation_method_round_trips_per_code_path(tmp_path: Path) -> None:
    """T3.4 — every forecasts row has non-NULL imputation_method, and the
    bedroom-borrowed row count matches the count of bedroom-specific rental
    inputs.

    NOT NULL is enforced by the T4.1 DDL (T4.2 covers the negative path).
    The per-code-path count is the new invariant: every (house, br) rental
    input with br != 'all' becomes exactly one nowcast_bedroom_borrowed row.
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        expected_borrowed = _seed_multi_bedroom_fixture(con)
        forecast_rental_sales._compute_direct_yields(con)
        forecast_rental_sales._compute_bedroom_borrowed_sales(con)
        nulls = con.execute(
            "SELECT COUNT(*) FROM forecasts WHERE imputation_method IS NULL"
        ).fetchone()
        borrowed = con.execute(
            "SELECT COUNT(*) FROM forecasts WHERE imputation_method = 'nowcast_bedroom_borrowed'"
        ).fetchone()
        # Distinct imputation_method values present must all match the
        # spec's enum — no stray strings.
        present_methods = {
            row[0]
            for row in con.execute("SELECT DISTINCT imputation_method FROM forecasts").fetchall()
        }
    finally:
        con.close()

    assert nulls is not None and nulls[0] == 0, (
        f"expected zero NULL imputation_method rows, got {nulls}"
    )
    assert borrowed is not None and borrowed[0] == expected_borrowed, (
        f"expected {expected_borrowed} bedroom-borrowed rows "
        f"(matching bedroom-specific rental inputs), got {borrowed}"
    )
    # Every present method should be a valid enum value per the spec.
    valid_methods = {
        "observed",
        "nowcast_sarima_cpi",
        "nowcast_yield_bridge_direct",
        "nowcast_yield_bridge_sal_cluster",
        "nowcast_yield_bridge_lga_cluster",
        "nowcast_bedroom_borrowed",
        "nowcast_direct_sarima_low_n",
        "forecast_sarima_cpi",
        "forecast_yield_bridge_direct",
        "forecast_yield_bridge_sal_cluster",
        "forecast_yield_bridge_lga_cluster",
        "forecast_bedroom_borrowed",
        "forecast_direct_sarima_low_n",
    }
    assert present_methods <= valid_methods, (
        f"forecasts contains non-enum imputation_method values: {present_methods - valid_methods}"
    )
