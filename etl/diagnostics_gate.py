"""Post-bake sMAPE gate (T6.2).

Reads `forecast_diagnostics` from the rental_sales DuckDB, computes per-
data-type median sMAPE (parsing `data_type` out of the pipe-joined
`series_id`), and exits non-zero if any data type's median exceeds its
threshold. Invoked by `make ci` after `make forecast-bake` so a quality
regression in the model fits CI-fails before reaching the artifact bundle.

Thresholds match the G6 ADR — rental nowcast is the high-confidence path
(real CPI exog) so its bar is tighter than sales nowcast (yield-bridged).
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import duckdb

from etl.config import RENTAL_SALES_DUCKDB

log = logging.getLogger(__name__)

# Per-data-type sMAPE ceilings. rental tighter because the nowcast exog
# (CPI) is observed; sales is yield-bridged through rental so it
# inherits any rental error plus the yield's own drift.
THRESHOLDS: dict[str, float] = {
    "rental": 0.15,
    "sales": 0.20,
}


def _per_type_median(con: duckdb.DuckDBPyConnection) -> dict[str, float]:
    """Return {data_type: median(smape)} for every type present in the table.

    `data_type` is parsed as the first pipe-delimited segment of `series_id`,
    matching the `'rental|...'` / `'sales|...'` shape the bake writes.
    """
    rows = con.execute(
        """
        SELECT SPLIT_PART(series_id, '|', 1) AS data_type,
               median(smape) AS median_smape
        FROM forecast_diagnostics
        WHERE smape IS NOT NULL
        GROUP BY 1
        """
    ).fetchall()
    return {dt: float(ms) for dt, ms in rows}


def check_gate(input_duckdb: Path) -> int:
    """Return 0 if all medians inside thresholds, 1 otherwise. Logs breaches."""
    if not input_duckdb.exists():
        print(f"error: {input_duckdb} not found", file=sys.stderr)
        return 2

    con = duckdb.connect(str(input_duckdb), read_only=True)
    try:
        medians = _per_type_median(con)
    finally:
        con.close()

    breaches: list[tuple[str, float, float]] = []
    for data_type, threshold in THRESHOLDS.items():
        median_smape = medians.get(data_type)
        if median_smape is None:
            continue  # type absent — nothing to check
        if median_smape > threshold:
            breaches.append((data_type, median_smape, threshold))

    if breaches:
        for dt, ms, th in breaches:
            print(
                f"BREACH: {dt} median sMAPE {ms:.4f} > threshold {th:.4f}",
                file=sys.stderr,
            )
        return 1

    for dt, ms in sorted(medians.items()):
        threshold = THRESHOLDS.get(dt, float("inf"))
        print(f"OK: {dt} median sMAPE {ms:.4f} <= {threshold:.4f}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="etl.diagnostics_gate",
        description="Fail-fast CI gate on post-bake forecast_diagnostics sMAPE.",
    )
    parser.add_argument(
        "--input-duckdb",
        type=Path,
        default=RENTAL_SALES_DUCKDB,
        help="DuckDB containing the populated forecast_diagnostics table.",
    )
    args = parser.parse_args()
    sys.exit(check_gate(args.input_duckdb))


if __name__ == "__main__":
    main()
