"""Cross-tier corroboration table tests (T8.3, T6.3)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import pandas as pd

from etl.steps import build_lga_hierarchy, build_sal_hierarchy, forecast_rental_sales
from etl.tests.test_build_lga_hierarchy import _make_grid_lga_parquet
from etl.tests.test_build_sal_hierarchy import _make_grid_sal_parquet


def _seed_dual_tier_rental(
    con: duckdb.DuckDBPyConnection,
    suburb_codes: list[str],
    lga_codes: list[str],
) -> None:
    """Seed rental rows for both suburb-tier and lga-tier geospatial_type values.

    Required for T8.3: SAL cluster median rent needs suburb rentals;
    LGA rent needs lga-tier rentals.
    """
    rows: list[dict[str, object]] = []
    base_row = {
        "time_bucket": date(2023, 6, 1),
        "dwelling_type": "all",
        "bedrooms": "all",
        "dwelling_class": "all",
        "statistic": "median",
        "data_type": "rental",
        "data_frequency": "quarterly",
        "source_file": "synthetic",
        "source_sheet": "synthetic",
        "cell": "synthetic",
    }
    for code in suburb_codes:
        rows.append(
            {
                **base_row,
                "geospatial": f"suburb_{code}",
                "geospatial_codes": code,
                "geospatial_type": "suburb",
                "value": 500.0,
            }
        )
    for code in lga_codes:
        rows.append(
            {
                **base_row,
                "geospatial": f"lga_{code}",
                "geospatial_codes": code,
                "geospatial_type": "lga",
                "value": 480.0,
            }
        )
    df = pd.DataFrame(rows)
    con.register("rs_src", df)
    con.execute("CREATE TABLE rental_sales AS SELECT * FROM rs_src")
    con.unregister("rs_src")


def test_corroboration_table_populated(tmp_path: Path) -> None:
    """T8.3 — forecast_diagnostics_corroboration table is populated, sample
    row has all fields non-NULL.

    Synthetic dual-tier setup: 25 SAL polygons + 9 LGA polygons with
    rental data on both tiers. After SAL + LGA builds and
    _compute_corroboration, the table must hold at least one row with
    every field populated.
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    lga_parquet = tmp_path / "synthetic_lga.parquet"
    _make_grid_sal_parquet(sal_parquet)
    _make_grid_lga_parquet(lga_parquet, side=3)

    suburb_codes = [str(c) for c in range(20_001, 20_026)]
    lga_codes = [str(c) for c in range(10_001, 10_010)]

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_dual_tier_rental(con, suburb_codes, lga_codes)
    finally:
        con.close()

    ts_models = tmp_path / "ts_models.duckdb"
    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=db_path,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )
    build_lga_hierarchy.run(
        input_lga_parquet=lga_parquet,
        output_duckdb=db_path,
        ts_models_duckdb=ts_models,
        cut_levels=(3, 5),
    )

    con = duckdb.connect(str(db_path))
    try:
        forecast_rental_sales._compute_corroboration(con)
        count_row = con.execute(
            "SELECT COUNT(*) FROM forecast_diagnostics_corroboration"
        ).fetchone()
        sample = con.execute(
            "SELECT lga_code, lga_rent, sal_cluster_level, "
            "       sal_cluster_median_rent, divergence_pct "
            "FROM forecast_diagnostics_corroboration LIMIT 1"
        ).fetchone()
    finally:
        con.close()

    assert count_row is not None and count_row[0] > 0, (
        f"expected at least one corroboration row, got {count_row}"
    )
    assert sample is not None, "expected at least one sample row"
    for i, field in enumerate(
        ("lga_code", "lga_rent", "sal_cluster_level", "sal_cluster_median_rent", "divergence_pct"),
    ):
        assert sample[i] is not None, f"{field} is NULL on sample row: {sample}"


def test_corroboration_row_per_lga(tmp_path: Path) -> None:
    """T6.3 — corroboration has at least one row per LGA with rental data,
    and divergence_pct is non-NULL on every row.

    Sharpens T8.3's existence check into a per-LGA invariant: the table must
    cover the full set of LGAs that have rental, not just a subset.
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    lga_parquet = tmp_path / "synthetic_lga.parquet"
    _make_grid_sal_parquet(sal_parquet)
    _make_grid_lga_parquet(lga_parquet, side=3)

    suburb_codes = [str(c) for c in range(20_001, 20_026)]
    lga_codes = [str(c) for c in range(10_001, 10_010)]

    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_dual_tier_rental(con, suburb_codes, lga_codes)
    finally:
        con.close()

    ts_models = tmp_path / "ts_models.duckdb"
    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=db_path,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )
    build_lga_hierarchy.run(
        input_lga_parquet=lga_parquet,
        output_duckdb=db_path,
        ts_models_duckdb=ts_models,
        cut_levels=(3, 5),
    )

    con = duckdb.connect(str(db_path))
    try:
        forecast_rental_sales._compute_corroboration(con)

        distinct_lgas = con.execute(
            "SELECT COUNT(DISTINCT lga_code) FROM forecast_diagnostics_corroboration"
        ).fetchone()
        lgas_with_rental = con.execute(
            """
            SELECT COUNT(DISTINCT geospatial_codes)
            FROM rental_sales
            WHERE data_type = 'rental' AND geospatial_type = 'lga'
              AND statistic = 'median' AND value IS NOT NULL
            """
        ).fetchone()
        null_divergence_count = con.execute(
            "SELECT COUNT(*) FROM forecast_diagnostics_corroboration WHERE divergence_pct IS NULL"
        ).fetchone()
    finally:
        con.close()

    assert distinct_lgas is not None
    assert lgas_with_rental is not None
    assert null_divergence_count is not None
    expected_lga_count = lgas_with_rental[0]
    actual_lga_count = distinct_lgas[0]
    assert actual_lga_count >= expected_lga_count, (
        f"expected COUNT(DISTINCT lga_code) >= {expected_lga_count} "
        f"(LGAs with rental), got {actual_lga_count}"
    )
    assert null_divergence_count[0] == 0, (
        f"expected divergence_pct non-NULL on every row; {null_divergence_count[0]} rows had NULL"
    )
