"""CLI tracer tests for the `etl forecast` command group (G1)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

from etl.cli import build_parser


def test_forecast_bake_help_lists_required_flags() -> None:
    """`etl forecast bake --help` exits 0 and surfaces the four core flags.

    T1.1 — tracer bullet that proves the new `forecast` parser group + `bake`
    leaf is wired through `etl/cli.py` + `etl/__main__.py`. Flag REGISTRATION
    only; the bake body lands in T1.3.
    """
    result = subprocess.run(
        [sys.executable, "-m", "etl", "forecast", "bake", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, (
        f"forecast bake --help exited {result.returncode}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )

    for flag in ("--horizon-q", "--n-jobs", "--seed", "--backtest-mode"):
        assert flag in result.stdout, (
            f"expected flag {flag!r} in --help output, got:\n{result.stdout}"
        )


def test_forecast_status_reports_table_size(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`etl forecast status` prints `0` when forecasts is absent, row count when present.

    T1.2 — exercises the read-only `status` verb against a real DuckDB in
    tmp_path. No mocks (per .claude/rules/python/tests.md).
    """
    db_path = tmp_path / "rental_sales.duckdb"

    # Touch the DuckDB so it exists but has no `forecasts` table yet.
    duckdb.connect(str(db_path)).close()

    parser = build_parser()
    args = parser.parse_args(["forecast", "status", "--output-duckdb", str(db_path)])
    args.func(args)
    empty_out = capsys.readouterr().out
    assert "0" in empty_out, f"expected row-count 0 in status output, got:\n{empty_out}"

    # Seed a one-row `forecasts` table and re-check.
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE forecasts AS SELECT 1 AS dummy")
    con.close()

    args = parser.parse_args(["forecast", "status", "--output-duckdb", str(db_path)])
    args.func(args)
    populated_out = capsys.readouterr().out
    assert "1" in populated_out, f"expected row-count 1 in status output, got:\n{populated_out}"
