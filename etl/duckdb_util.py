"""Shared DuckDB helpers for the ETL pipeline."""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

import duckdb

log = logging.getLogger(__name__)


def compact_duckdb(path: Path) -> None:
    """Rewrite a DuckDB file into a fresh one to reclaim page bloat.

    Uses EXPORT/IMPORT DATABASE — a faithful schema+data round-trip that
    preserves NOT NULL constraints. A plain `CREATE TABLE AS SELECT` copy
    would silently drop them (and break the explicit-DDL post-condition
    test). DuckDB doesn't return freed pages to the OS, so steps that
    DROP/CREATE or CREATE-OR-REPLACE large tables leave the file well past
    the live data size; the rewrite reclaims that slack. Temp paths are
    PID-unique under `tmp/` so concurrent runs never collide, and
    `os.replace` is atomic because `tmp/` and the artifact share the
    project-root filesystem.

    Used by both the forecast bake (`forecast_rental_sales`) and the
    coverage-matrix imputation step (`impute_coverage`).
    """
    pid = os.getpid()
    export_dir = Path("tmp") / f"{path.stem}.{pid}.export"
    compact_path = Path("tmp") / f"{path.stem}.{pid}.compact.duckdb"
    export_dir.parent.mkdir(parents=True, exist_ok=True)
    if export_dir.exists():
        shutil.rmtree(export_dir)
    if compact_path.exists():
        compact_path.unlink()

    src = duckdb.connect(str(path))
    try:
        src.execute(f"EXPORT DATABASE '{export_dir}'")
    finally:
        src.close()

    dst = duckdb.connect(str(compact_path))
    try:
        dst.execute(f"IMPORT DATABASE '{export_dir}'")
    finally:
        dst.close()

    os.replace(compact_path, path)
    shutil.rmtree(export_dir, ignore_errors=True)
    log.info("compacted %s (%.2f MB)", path, path.stat().st_size / 1_048_576)
