"""Coverage-matrix imputation tests (docs/specs/impute.md)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon

from etl.steps import impute_coverage

# Canonical rental_sales column order — imputed rows must match it exactly.
_COLS = [
    "geospatial",
    "geospatial_codes",
    "geospatial_type",
    "time_bucket",
    "dwelling_type",
    "bedrooms",
    "dwelling_class",
    "statistic",
    "value",
    "data_type",
    "data_frequency",
    "source_file",
    "source_sheet",
    "cell",
]


def _row(
    *,
    codes: str,
    geo_type: str,
    dwelling: str,
    bedrooms: str,
    statistic: str,
    value: float,
    data_type: str = "rental",
    bucket: date = date(2025, 9, 1),
    source_file: str = "vendor.xlsx",
) -> dict[str, object]:
    return {
        "geospatial": f"region_{codes}",
        "geospatial_codes": codes,
        "geospatial_type": geo_type,
        "time_bucket": bucket,
        "dwelling_type": dwelling,
        "bedrooms": bedrooms,
        "dwelling_class": "all",
        "statistic": statistic,
        "value": value,
        "data_type": data_type,
        "data_frequency": "quarterly",
        "source_file": source_file,
        "source_sheet": "synthetic",
        "cell": "A1",
    }


def _seed_parquet(path: Path, rows: list[dict[str, object]]) -> None:
    pd.DataFrame(rows, columns=_COLS).to_parquet(path, index=False)


def _seed_geometry(tmp_path: Path) -> tuple[Path, Path]:
    """Write tiny synthetic SAL parquet + LGA geojson for Class D.

    Two unit-square SALs (S1, S2) sit side by side inside one LGA (L1
    'Testville'). `impute_coverage.run` needs these to build the SAL->LGA
    crosswalk; tests that don't exercise Class D still need valid files so
    the crosswalk builder doesn't raise.
    """
    sal = gpd.GeoDataFrame(
        {
            "SAL_CODE21": ["S1", "S2"],
            "geometry": [
                Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),
                Polygon([(1, 0), (2, 0), (2, 1), (1, 1)]),
            ],
        },
        crs="EPSG:4326",
    )
    lga = gpd.GeoDataFrame(
        {
            "LGA_CODE24": ["L1"],
            "LGA_NAME24": ["Testville"],
            "geometry": [Polygon([(0, 0), (2, 0), (2, 1), (0, 1)])],
        },
        crs="EPSG:4326",
    )
    sal_path = tmp_path / "sal.parquet"
    lga_path = tmp_path / "lga.geojson"
    sal.to_parquet(sal_path)
    lga.to_file(lga_path, driver="GeoJSON")
    return sal_path, lga_path


def _run(tmp_path: Path, parquet: Path, duckdb_path: Path) -> int:
    """Call impute_coverage.run with synthetic geometry — keeps every test
    on the real run() path (parquet + duckdb + crosswalk + compaction)."""
    sal_path, lga_path = _seed_geometry(tmp_path)
    return impute_coverage.run(
        input_parquet=parquet,
        output_duckdb=duckdb_path,
        sal_parquet=sal_path,
        lga_geojson=lga_path,
    )


def test_class_a_rental_dwelling_all_is_count_weighted(tmp_path: Path) -> None:
    """Class A — `rental x lga x house x all` is the count-weighted mean of
    the per-bedroom house medians, with the summed count.

    house 2br: median 400, count 10
    house 3br: median 500, count 30
    house 4br: median 600, count 10
    -> all median = (400*10 + 500*30 + 600*10) / 50 = 500.0
    -> all count  = 50
    """
    parquet = tmp_path / "rental_sales.parquet"
    rows = [
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="2",
            statistic="median",
            value=400.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="2",
            statistic="count",
            value=10.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="3",
            statistic="median",
            value=500.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="3",
            statistic="count",
            value=30.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="4",
            statistic="median",
            value=600.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="4",
            statistic="count",
            value=10.0,
        ),
    ]
    _seed_parquet(parquet, rows)

    n_imputed = _run(tmp_path, parquet, tmp_path / "absent.duckdb")
    assert n_imputed > 0, "expected Class A to synthesise rows"

    out = pd.read_parquet(parquet)
    all_rows = out[
        (out["data_type"] == "rental")
        & (out["geospatial_type"] == "lga")
        & (out["dwelling_type"] == "house")
        & (out["bedrooms"] == "all")
    ]
    medians = all_rows[all_rows["statistic"] == "median"]
    counts = all_rows[all_rows["statistic"] == "count"]
    assert len(medians) == 1, f"expected one imputed (house,all) median row, got {len(medians)}"
    assert len(counts) == 1, f"expected one imputed (house,all) count row, got {len(counts)}"
    assert abs(float(medians.iloc[0]["value"]) - 500.0) < 1e-9, (
        f"count-weighted median should be 500.0, got {medians.iloc[0]['value']}"
    )
    assert abs(float(counts.iloc[0]["value"]) - 50.0) < 1e-9
    assert str(medians.iloc[0]["source_file"]).startswith(impute_coverage.IMPUTED_PREFIX)


def test_impute_is_idempotent(tmp_path: Path) -> None:
    """Re-running impute strips prior imputed rows first — no double-impute."""
    parquet = tmp_path / "rental_sales.parquet"
    rows = [
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="unit",
            bedrooms="1",
            statistic="median",
            value=300.0,
        ),
        _row(
            codes="L1", geo_type="lga", dwelling="unit", bedrooms="1", statistic="count", value=20.0
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="unit",
            bedrooms="2",
            statistic="median",
            value=400.0,
        ),
        _row(
            codes="L1", geo_type="lga", dwelling="unit", bedrooms="2", statistic="count", value=20.0
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="unit",
            bedrooms="3",
            statistic="median",
            value=500.0,
        ),
        _row(
            codes="L1", geo_type="lga", dwelling="unit", bedrooms="3", statistic="count", value=20.0
        ),
    ]
    _seed_parquet(parquet, rows)

    n1 = _run(tmp_path, parquet, tmp_path / "absent.duckdb")
    after_first = len(pd.read_parquet(parquet))
    n2 = _run(tmp_path, parquet, tmp_path / "absent.duckdb")
    after_second = len(pd.read_parquet(parquet))

    assert n1 == n2, f"imputed-row count must be stable across runs ({n1} vs {n2})"
    assert after_first == after_second, (
        f"row count must be stable across re-runs ({after_first} vs {after_second}) — "
        "prior imputed rows should be stripped before recomputing"
    )


def test_impute_refreshes_duckdb_table(tmp_path: Path) -> None:
    """When the DuckDB exists, impute CREATE-OR-REPLACEs `rental_sales`
    with the observed+imputed union, leaving sibling tables intact."""
    parquet = tmp_path / "rental_sales.parquet"
    db_path = tmp_path / "rental_sales.duckdb"
    rows = [
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="2",
            statistic="median",
            value=400.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="2",
            statistic="count",
            value=10.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="3",
            statistic="median",
            value=500.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="3",
            statistic="count",
            value=10.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="4",
            statistic="median",
            value=600.0,
        ),
        _row(
            codes="L1",
            geo_type="lga",
            dwelling="house",
            bedrooms="4",
            statistic="count",
            value=10.0,
        ),
    ]
    _seed_parquet(parquet, rows)

    # Pre-create the DuckDB with rental_sales + a sibling table.
    con = duckdb.connect(str(db_path))
    try:
        con.register("seed", pd.DataFrame(rows, columns=_COLS))
        con.execute("CREATE TABLE rental_sales AS SELECT * FROM seed")
        con.execute("CREATE TABLE cpi AS SELECT 1 AS sentinel")
        con.unregister("seed")
    finally:
        con.close()

    _run(tmp_path, parquet, db_path)

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rs_count = con.execute("SELECT COUNT(*) FROM rental_sales").fetchone()
        imputed_count = con.execute(
            "SELECT COUNT(*) FROM rental_sales WHERE source_file LIKE 'imputed:%'"
        ).fetchone()
        cpi_intact = con.execute("SELECT sentinel FROM cpi").fetchone()
    finally:
        con.close()

    assert rs_count is not None and rs_count[0] == 8, (
        f"expected 6 observed + 2 imputed = 8 rental_sales rows, got {rs_count}"
    )
    assert imputed_count is not None and imputed_count[0] == 2
    assert cpi_intact is not None and cpi_intact[0] == 1, "sibling table must survive the refresh"


def test_class_c_sales_all_is_dwelling_weighted(tmp_path: Path) -> None:
    """Class C — `sales x suburb x all x all` combines the observed
    `sales x suburb x {unit,house} x all` medians, weighted by the
    Class-A imputed rental dwelling-count for that SAL/year.

    rental unit 1/2/3 counts 10/20/10 -> Class-A unit-all count = 40
    rental house 2/3/4 counts 30/40/30 -> Class-A house-all count = 100
    sales unit-all = 500_000, sales house-all = 800_000
    -> sales all-all = (500_000*40 + 800_000*100) / 140 = 714_285.714...
    """
    parquet = tmp_path / "rental_sales.parquet"
    rb = date(2023, 3, 1)  # rental quarter, same year as sales
    sb = date(2023, 1, 1)  # sales annual
    rows = [
        # rental unit per-bedroom (median + count) -> Class A unit-all
        *[
            _row(
                codes="S1",
                geo_type="suburb",
                dwelling="unit",
                bedrooms=br,
                statistic=s,
                value=v,
                bucket=rb,
            )
            for br, mc in [("1", (300.0, 10.0)), ("2", (350.0, 20.0)), ("3", (400.0, 10.0))]
            for s, v in [("median", mc[0]), ("count", mc[1])]
        ],
        # rental house per-bedroom -> Class A house-all
        *[
            _row(
                codes="S1",
                geo_type="suburb",
                dwelling="house",
                bedrooms=br,
                statistic=s,
                value=v,
                bucket=rb,
            )
            for br, mc in [("2", (500.0, 30.0)), ("3", (600.0, 40.0)), ("4", (700.0, 30.0))]
            for s, v in [("median", mc[0]), ("count", mc[1])]
        ],
        # observed sales dwelling-all
        _row(
            codes="S1",
            geo_type="suburb",
            dwelling="unit",
            bedrooms="all",
            statistic="median",
            value=500_000.0,
            data_type="sales",
            bucket=sb,
        ),
        _row(
            codes="S1",
            geo_type="suburb",
            dwelling="house",
            bedrooms="all",
            statistic="median",
            value=800_000.0,
            data_type="sales",
            bucket=sb,
        ),
    ]
    _seed_parquet(parquet, rows)
    _run(tmp_path, parquet, tmp_path / "absent.duckdb")

    out = pd.read_parquet(parquet)
    all_all = out[
        (out["data_type"] == "sales")
        & (out["geospatial_type"] == "suburb")
        & (out["dwelling_type"] == "all")
        & (out["bedrooms"] == "all")
        & (out["statistic"] == "median")
    ]
    assert len(all_all) == 1, f"expected one imputed sales all-all row, got {len(all_all)}"
    expected = (500_000.0 * 40 + 800_000.0 * 100) / 140
    got = float(all_all.iloc[0]["value"])
    assert abs(got - expected) < 1e-3, (
        f"dwelling-count-weighted sales all should be {expected:.3f}, got {got}"
    )
    assert str(all_all.iloc[0]["source_file"]).startswith(impute_coverage.IMPUTED_PREFIX)


def test_class_b_sales_bedroom_uses_rental_ratio(tmp_path: Path) -> None:
    """Class B — `sales x suburb x house x 3` is the dwelling-all sale price
    scaled by the rental per-bedroom ratio.

    rental house 2/3/4 medians 400/600/800, equal counts -> Class-A
    house-all median = (400+600+800)/3 = 600.
    sales house-all = 900_000.
    -> ratio(3br) = 600/600 = 1.0  -> sales house 3 = 900_000
    -> ratio(2br) = 400/600        -> sales house 2 = 600_000
    -> ratio(4br) = 800/600        -> sales house 4 = 1_200_000
    """
    parquet = tmp_path / "rental_sales.parquet"
    rb = date(2023, 3, 1)
    sb = date(2023, 1, 1)
    rows = [
        *[
            _row(
                codes="S1",
                geo_type="suburb",
                dwelling="house",
                bedrooms=br,
                statistic=s,
                value=v,
                bucket=rb,
            )
            for br, mc in [("2", (400.0, 10.0)), ("3", (600.0, 10.0)), ("4", (800.0, 10.0))]
            for s, v in [("median", mc[0]), ("count", mc[1])]
        ],
        _row(
            codes="S1",
            geo_type="suburb",
            dwelling="house",
            bedrooms="all",
            statistic="median",
            value=900_000.0,
            data_type="sales",
            bucket=sb,
        ),
    ]
    _seed_parquet(parquet, rows)
    _run(tmp_path, parquet, tmp_path / "absent.duckdb")

    out = pd.read_parquet(parquet)
    b = (
        out[
            (out["data_type"] == "sales")
            & (out["geospatial_type"] == "suburb")
            & (out["dwelling_type"] == "house")
            & (out["source_file"].astype(str).str.startswith(impute_coverage.IMPUTED_PREFIX))
            & (out["statistic"] == "median")
        ]
        .set_index("bedrooms")["value"]
        .to_dict()
    )
    assert set(b) == {"2", "3", "4"}, f"expected house 2/3/4 imputed, got {sorted(map(str, b))}"
    assert abs(b["3"] - 900_000.0) < 1e-3, f"house 3 should be 900_000, got {b['3']}"
    assert abs(b["2"] - 900_000.0 * 400 / 600) < 1e-3, f"house 2 should be 600_000, got {b['2']}"
    assert abs(b["4"] - 900_000.0 * 800 / 600) < 1e-3, f"house 4 should be 1_200_000, got {b['4']}"


def test_class_d_sales_lga_rolls_up_from_sal(tmp_path: Path) -> None:
    """Class D — `sales x lga x *` is the equal-weight mean of the member
    SALs' sales medians, via the SAL->LGA spatial crosswalk.

    Synthetic geometry puts SAL S1 and S2 inside LGA L1. Seed sales
    house-all: S1 = 800_000, S2 = 600_000.
    -> sales lga L1 house all = mean(800_000, 600_000) = 700_000
    """
    parquet = tmp_path / "rental_sales.parquet"
    sb = date(2023, 1, 1)
    rows = [
        _row(
            codes="S1",
            geo_type="suburb",
            dwelling="house",
            bedrooms="all",
            statistic="median",
            value=800_000.0,
            data_type="sales",
            bucket=sb,
        ),
        _row(
            codes="S2",
            geo_type="suburb",
            dwelling="house",
            bedrooms="all",
            statistic="median",
            value=600_000.0,
            data_type="sales",
            bucket=sb,
        ),
    ]
    _seed_parquet(parquet, rows)
    _run(tmp_path, parquet, tmp_path / "absent.duckdb")

    out = pd.read_parquet(parquet)
    lga = out[
        (out["data_type"] == "sales")
        & (out["geospatial_type"] == "lga")
        & (out["geospatial_codes"] == "L1")
        & (out["dwelling_type"] == "house")
        & (out["bedrooms"] == "all")
        & (out["statistic"] == "median")
    ]
    assert len(lga) == 1, f"expected one imputed sales lga L1 house-all row, got {len(lga)}"
    assert abs(float(lga.iloc[0]["value"]) - 700_000.0) < 1e-3, (
        f"LGA roll-up should be mean(800k, 600k) = 700_000, got {lga.iloc[0]['value']}"
    )
    assert str(lga.iloc[0]["geospatial"]) == "Testville", "LGA name should come from the crosswalk"
    assert str(lga.iloc[0]["source_file"]).startswith(impute_coverage.IMPUTED_PREFIX)
