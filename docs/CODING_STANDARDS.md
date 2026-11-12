# Coding standards

How code in `hows-the-serenity` is written.
Process (setup, branches, PRs, review) lives in [CONTRIBUTING.md](../CONTRIBUTING.md) and [TICKETING.md](TICKETING.md).
A rule a tool enforces is a pointer to that tool's config here, never restated prose.

## Baseline tenets

1. **Autoformatting is a must.** No hand-formatted code; CI fails on any unformatted file.
2. **Linting runs on the strictest rule set, and every warning is an error.**
3. **Type checking runs on the strictest rule set.**
4. **Unit test coverage stays above 90%.** CI fails below the threshold.
5. **Never use mocks. Always test real code.** Use real dependencies, real temporary files and dependency injection; code that cannot be tested for real is not tested at all.
6. **Never write tests that are tautologies of the implementation.** A test asserts observable behaviour against an independently known expected value. It never re-derives that value with the code under test. It never asserts that the code calls what the code calls.
7. **Complexity is measured and capped wherever the stack has a tool for it.** Cyclomatic complexity and maintainability metrics such as Halstead volume run in CI. Their thresholds live in the tool's config, and a breach fails the build.

Rows marked **GAP** have no enforcing tool or config yet; the Maintainer decides how to close each one.

## TypeScript

| Tenet | Enforced by |
|---|---|
| Autoformatting | Biome formatter, [`biome.json`](../biome.json) `formatter`; `make format-check` and `biome ci .` in CI |
| Strict linting, warnings as errors | `biome ci .` fails on every diagnostic level ([`biome.json`](../biome.json)). **GAP:** the rule set is `preset: recommended`, not the strictest |
| Strict type checking | `tsc -b` via `make typecheck`, with `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` in [`tsconfig.app.json`](../tsconfig.app.json). **GAP:** `strict` relies on the TypeScript 6 default and is not pinned |
| Coverage above 90% | **GAP:** Vitest runs (`make test-ts`) with no coverage threshold in [`vite.config.ts`](../vite.config.ts) |
| No mocks | Code review gate. **GAP:** no lint rule bans `vi.mock` / `vi.fn` |
| No tautological tests | Code review gate |
| Complexity capped | **GAP:** no complexity rule is enabled (Biome `noExcessiveCognitiveComplexity` is available) |

Repo idioms: see [`src/AGENTS.md`](../src/AGENTS.md) for module layout and the `@/*` alias, and the root [`AGENTS.md`](../AGENTS.md) for the e2e slug taxonomy.

## Python

| Tenet | Enforced by |
|---|---|
| Autoformatting | `ruff format`, `make format-check-py` in CI |
| Strict linting, warnings as errors | `ruff check etl` ([`pyproject.toml`](../pyproject.toml) `[tool.ruff.lint] select`). **GAP:** the selected set (`E F W I B UP SIM RUF`) is not the strictest |
| Strict type checking | `mypy` with `strict = true` ([`pyproject.toml`](../pyproject.toml) `[tool.mypy]`), `make typecheck-py` |
| Coverage above 90% | **GAP:** `pytest` runs (`make test-py`) with no coverage plugin or threshold |
| No mocks | Code review gate. **GAP:** no lint rule bans `unittest.mock` |
| No tautological tests | Code review gate |
| Complexity capped | **GAP:** ruff's `C90` (mccabe) rule is not selected |

Repo idioms: the `etl` package layout and CLI are described in the root [`AGENTS.md`](../AGENTS.md) and the `make etl-*` targets.
