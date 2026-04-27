.PHONY: help install install-ts install-py dev agentic-dev build preview clean
.PHONY: audit audit-ts audit-py
.PHONY: format format-ts format-py format-check format-check-ts format-check-py
.PHONY: lint lint-ts lint-py lint-fix lint-fix-ts lint-fix-py
.PHONY: typecheck typecheck-ts typecheck-py
.PHONY: test test-ts test-py test-watch test-ui test-e2e test-e2e-ui
.PHONY: fix ci
.PHONY: etl-extract etl-extract-iso etl-publish etl-tile etl-tile-iso etl-status data
.PHONY: port-debug port-clean agentic-port-clean

# =============================================================================
# Port Configuration
# =============================================================================
DEV_PORT ?= 5173
AGENTIC_DEV_PORT ?= 5174

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# =============================================================================
# Installation (sentinel-file pattern — both ecosystems are idempotent)
# =============================================================================

install: install-ts install-py ## Install all deps (bun + uv)

install-ts: node_modules/.bun_deps ## Install TypeScript deps
node_modules/.bun_deps: package.json bun.lock
	bun install
	@touch $@

install-py: .venv/.uv_deps ## Install Python deps
.venv/.uv_deps: pyproject.toml uv.lock
	uv sync
	@touch $@

# =============================================================================
# Dev servers (TypeScript)
# =============================================================================

dev: install-ts ## Run Vite dev server for human developers (port 5173)
	@echo "==============================================================================="
	@echo "| Starting Vite dev server (HUMAN profile) — http://localhost:$(DEV_PORT)        |"
	@echo "==============================================================================="
	bun run dev -- --port $(DEV_PORT) --strictPort

agentic-dev: install-ts ## Run Vite dev server for AI agent development (port 5174)
	@echo "==============================================================================="
	@echo "| Starting Vite dev server (AGENTIC profile) — http://localhost:$(AGENTIC_DEV_PORT)      |"
	@echo "==============================================================================="
	bun run dev -- --port $(AGENTIC_DEV_PORT) --strictPort

build: install-ts ## Production build (tsc -b && vite build) -> dist/
	bun run build

preview: install-ts ## Preview the built bundle locally
	bun run preview

# =============================================================================
# Code Quality — language-suffixed leaves + aggregator meta-targets
# =============================================================================
# Aggregator meta-targets (audit / format / lint / typecheck / test) are the
# public surface — humans run `make ci` and don't think about languages.
# Each language's tooling lives behind a -ts / -py suffix.

audit: audit-ts audit-py ## Audit all dependencies (high+ severity only)

audit-ts: install-ts ## Audit TypeScript deps via bun audit
	bun audit --audit-level=high

audit-py: install-py ## Audit Python deps (placeholder — uv pip audit is preview-only)
	@echo "audit-py: skipped (uv has no stable audit subcommand yet)"

format: format-ts format-py ## Auto-format all code (writes)

format-ts: install-ts ## Auto-format TypeScript with Biome
	bun run format

format-py: install-py ## Auto-format Python with ruff
	uv run ruff format etl

format-check: format-check-ts format-check-py ## Format check (no writes — fails on drift)

format-check-ts: install-ts ## Biome format --check
	bun run format-check

format-check-py: install-py ## ruff format --check
	uv run ruff format --check etl

lint: lint-ts lint-py ## Strict lint (CI-mode — fails on warnings/info too)

lint-ts: install-ts audit-ts ## Biome ci + bun audit
	bun run lint

lint-py: install-py ## ruff check
	uv run ruff check etl

lint-fix: lint-fix-ts lint-fix-py ## Auto-fix lint findings (leaves formatting alone)

lint-fix-ts: install-ts ## Biome lint --write --unsafe
	bun run lint-fix

lint-fix-py: install-py ## ruff check --fix
	uv run ruff check --fix etl

typecheck: typecheck-ts typecheck-py ## Type check all code

typecheck-ts: install-ts ## tsc -b (no emit — leaf tsconfigs set noEmit)
	bunx --bun tsc -b

typecheck-py: install-py ## mypy (strict) on the etl package
	uv run mypy etl

test: test-ts test-py ## Run all unit tests (does NOT run e2e — see test-e2e)

test-ts: install-ts ## Vitest single-pass
	bun run test --run --passWithNoTests

test-py: install-py ## pytest on etl/tests
	uv run pytest

test-watch: install-ts ## Vitest in watch mode
	bun run test

test-ui: install-ts ## Vitest @vitest/ui dashboard
	bun run test:ui

test-e2e: install-ts ## Playwright e2e (auto-starts dev server on agentic port)
	bun run test:e2e

test-e2e-ui: install-ts ## Playwright in interactive UI mode
	bun run test:e2e -- --ui

# =============================================================================
# Inner-loop meta-targets — `make fix ci` is the canonical sequence
# =============================================================================

fix: install format lint-fix ## Auto-fix all fixable lint + format issues across both languages

ci: audit build format-check typecheck lint test test-e2e ## Full CI gate (mirrors GitHub Actions)

# =============================================================================
# ETL pipeline — Python; produces files under data/converted/ and public/data/
# =============================================================================
# File-rule targets give Make-native dependency tracking: rerun publish/tile
# steps without re-extracting if only the publish/tile code changed.

ETL_RUN := uv run -m etl

# SAL (suburb boundaries)
SAL_ZIP := data/originals/boundaries/SAL_2021_AUST_GDA2020_SHP.zip
SAL_PARQUET := data/converted/sal_2021_aust_gda2020.parquet
SAL_TILES_DIR := public/data/tiles/suburbs

# Foot isochrones (walkability corridors)
ISO_FOOT_DIR := data/originals/isochrones/foot
ISO_FOOT_PARQUET := data/converted/isochrones_foot.parquet
ISO_FOOT_5_TILES_DIR := public/data/tiles/iso_foot_5
ISO_FOOT_15_TILES_DIR := public/data/tiles/iso_foot_15

etl-extract: $(SAL_PARQUET) ## Extract SAL zip -> GeoParquet intermediate
$(SAL_PARQUET): $(SAL_ZIP) | install-py
	$(ETL_RUN) extract sal --input $< --output $@

etl-tile: $(SAL_TILES_DIR) ## Tile SAL parquet -> MVT XYZ tile tree
$(SAL_TILES_DIR): $(SAL_PARQUET) | install-py
	$(ETL_RUN) tile sal --input $<

etl-extract-iso: $(ISO_FOOT_PARQUET) ## Concat + dissolve foot isochrones -> GeoParquet
$(ISO_FOOT_PARQUET): | install-py
	$(ETL_RUN) extract isochrones --input $(ISO_FOOT_DIR) --output $@

etl-tile-iso: $(ISO_FOOT_5_TILES_DIR) $(ISO_FOOT_15_TILES_DIR) ## Tile foot isochrone corridors (5min + 15min)
$(ISO_FOOT_5_TILES_DIR): $(ISO_FOOT_PARQUET) | install-py
	$(ETL_RUN) tile isochrone --duration 5
$(ISO_FOOT_15_TILES_DIR): $(ISO_FOOT_PARQUET) | install-py
	$(ETL_RUN) tile isochrone --duration 15

etl-publish: install-py ## Publish full SAL parquet -> single GeoJSON (legacy / reference)
	$(ETL_RUN) publish sal

etl-status: install-py ## Show pipeline artifact status
	$(ETL_RUN) status

data: etl-extract etl-tile etl-extract-iso etl-tile-iso ## Build all geospatial outputs

# =============================================================================
# Port Management
# =============================================================================

port-debug: ## Show which dev ports are in use
	@pid=$$(lsof -ti:$(DEV_PORT) 2>&1); [ -n "$$pid" ] && echo "Port $(DEV_PORT) (human)   in use by PID $$pid" || echo "Port $(DEV_PORT) (human)   free."
	@pid=$$(lsof -ti:$(AGENTIC_DEV_PORT) 2>&1); [ -n "$$pid" ] && echo "Port $(AGENTIC_DEV_PORT) (agentic) in use by PID $$pid" || echo "Port $(AGENTIC_DEV_PORT) (agentic) free."

port-clean: ## Kill processes on the human dev port only
	@pid=$$(lsof -ti:$(DEV_PORT) 2>&1); [ -n "$$pid" ] && kill -9 $$pid && echo "Killed PID $$pid on port $(DEV_PORT)" || echo "Port $(DEV_PORT) free."

agentic-port-clean: ## Kill processes on the agentic dev port only
	@pid=$$(lsof -ti:$(AGENTIC_DEV_PORT) 2>&1); [ -n "$$pid" ] && kill -9 $$pid && echo "Killed PID $$pid on port $(AGENTIC_DEV_PORT)" || echo "Port $(AGENTIC_DEV_PORT) free."

# =============================================================================
# Cleanup
# =============================================================================

clean: ## Clean build artifacts, test outputs, deps, venv, tmp
	rm -rf dist coverage e2e-screenshots playwright-report test-results node_modules .venv tmp
