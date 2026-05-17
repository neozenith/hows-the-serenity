"""CI-gate tests for the post-bake sMAPE thresholds (T6.2)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import duckdb

from etl.steps.forecast_rental_sales import _FORECAST_DIAGNOSTICS_DDL


def _seed_diagnostics(con: duckdb.DuckDBPyConnection, rows: list[tuple[str, float]]) -> None:
    """Seed `forecast_diagnostics` with (series_id, smape) tuples."""
    con.execute(_FORECAST_DIAGNOSTICS_DDL)
    for series_id, smape in rows:
        con.execute(
            "INSERT INTO forecast_diagnostics (series_id, smape, n_obs) VALUES (?, ?, ?)",
            [series_id, smape, 96],
        )


def test_sMAPE_gate_fails_above_threshold(tmp_path: Path) -> None:
    """T6.2 — gate exits non-zero when median rental sMAPE > 0.15.

    Synthetic seed: 5 rental rows with sMAPE values whose median is 0.25
    (well above the 0.15 rental threshold). Gate must exit non-zero AND
    stderr must mention the breach.
    """
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_diagnostics(
            con,
            [
                ("rental|suburb|20001|all|all", 0.10),
                ("rental|suburb|20002|all|all", 0.20),
                ("rental|suburb|20003|all|all", 0.25),  # median
                ("rental|suburb|20004|all|all", 0.30),
                ("rental|suburb|20005|all|all", 0.40),
            ],
        )
    finally:
        con.close()

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "etl.diagnostics_gate",
            "--input-duckdb",
            str(db_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0, (
        f"expected non-zero exit on sMAPE breach; got {result.returncode}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "rental" in result.stderr.lower(), (
        f"stderr must mention 'rental' breach; got: {result.stderr}"
    )


def test_sMAPE_gate_passes_under_threshold(tmp_path: Path) -> None:
    """Companion: gate exits 0 when all medians are inside thresholds."""
    db_path = tmp_path / "rental_sales.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        _seed_diagnostics(
            con,
            [
                ("rental|suburb|20001|all|all", 0.05),
                ("rental|suburb|20002|all|all", 0.08),
                ("rental|suburb|20003|all|all", 0.10),  # median
            ],
        )
    finally:
        con.close()

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "etl.diagnostics_gate",
            "--input-duckdb",
            str(db_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"expected exit 0 when all medians below threshold; got {result.returncode}\n"
        f"stderr:\n{result.stderr}"
    )
