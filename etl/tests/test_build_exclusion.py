"""Build-tree-shake gate (T9.2).

Verifies that `bun run build` invoked without `VITE_ENABLE_EXPLORE` produces
a `dist/` whose bundled JS does NOT contain the Explorer chain. This is the
load-bearing gate that proves the production Pages deploy never ships the
local-only analyst SPA.

The test is slow (~30s for the full Vite build) but unavoidable — only an
end-to-end build inspection can confirm Vite's tree-shaker dropped the
right code.

The spec's original grep strings (`ForecastsTable`, `@tanstack/react-table`)
do not survive Vite's production minifier — terser renames identifiers to
single letters. What DOES survive is the chunk filename emitted by Vite's
import-graph analysis: an `Explorer-*.js` lazy chunk only appears when
`router.tsx`'s `VITE_ENABLE_EXPLORE === "true"` branch evaluates true at
build time. So the real discriminator is the presence of these chunks.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DIST_DIR = PROJECT_ROOT / "dist"
ASSETS_DIR = DIST_DIR / "assets"

# Chunk filename prefixes that Vite emits only when the Explorer is enabled.
# These come from the `lazy(() => import("./routes/Explorer"))` graph;
# minification can't touch them because they're emit names, not identifiers.
FORBIDDEN_CHUNK_PREFIXES = (
    "Explorer-",  # the Explorer route entry chunk
)
# duckdb-* is intentionally NOT forbidden: DuckDB-WASM is now used by
# the main map's SuburbPlot chart queries (rental, sales, yield, CPI),
# so a `duckdb-*` chunk is the expected tree-shaking outcome when two
# or more lazy chunks share it (SuburbPlot + the lazily-loaded
# ModelDetailsPanel inside the Models tab).

# Source-string defence in depth: catches the case where minification is
# turned off in a future Vite config change. These will not catch a real
# leak under current settings (terser renames them) but cost nothing to
# check.
FORBIDDEN_SUBSTRINGS = (
    "ForecastsTable",
    "@tanstack/react-table",
    "explorer-queries",
)


def test_production_build_excludes_explorer_assets() -> None:
    """Build with VITE_ENABLE_EXPLORE unset; assert Explorer chunks absent."""
    env = {k: v for k, v in os.environ.items() if k != "VITE_ENABLE_EXPLORE"}
    result = subprocess.run(
        ["bun", "run", "build"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"bun run build exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-2000:]}\nstderr:\n{result.stderr[-2000:]}"
    )

    assert ASSETS_DIR.exists(), f"dist/assets not found at {ASSETS_DIR}"
    js_files = list(ASSETS_DIR.glob("*.js"))
    assert js_files, f"no .js files emitted into {ASSETS_DIR}"

    # Primary check: no Explorer/DuckDB lazy chunks should exist.
    leaked_chunks = [
        p.name
        for p in js_files
        if any(p.name.startswith(pref) for pref in FORBIDDEN_CHUNK_PREFIXES)
    ]
    assert not leaked_chunks, (
        "Explorer/DuckDB lazy chunks leaked into production build:\n"
        + "\n".join(f"  - {n}" for n in leaked_chunks)
        + "\n\nThis means router.tsx's VITE_ENABLE_EXPLORE conditional did not "
        "tree-shake the Explorer subtree. Production Pages would ship the analyst SPA."
    )

    # Defence in depth: source-string grep. Only effective if minification
    # is disabled, but catches future config drift.
    leaks: list[tuple[Path, str]] = []
    for js_path in js_files:
        try:
            text = js_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for needle in FORBIDDEN_SUBSTRINGS:
            if needle in text:
                leaks.append((js_path, needle))

    assert not leaks, "Explorer source identifiers leaked into production bundle:\n" + "\n".join(
        f"  {p.relative_to(PROJECT_ROOT)}: contains {needle!r}" for p, needle in leaks
    )
