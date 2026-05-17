.PHONY: help install install-ts install-py dev agentic-dev build preview clean
.PHONY: audit audit-ts audit-py
.PHONY: format format-ts format-py format-check format-check-ts format-check-py
.PHONY: lint lint-ts lint-py lint-fix lint-fix-ts lint-fix-py
.PHONY: typecheck typecheck-ts typecheck-py
.PHONY: test test-ts test-py test-watch test-ui test-e2e test-e2e-ui e2e-report
.PHONY: fix ci
.PHONY: etl etl-extracts etl-tiles
.PHONY: etl-extract-sal etl-extract-rental-sales etl-impute etl-extract-cpi
.PHONY: etl-extract-sal-hierarchy etl-extract-lga-hierarchy
.PHONY: etl-extract-iso etl-extract-ptv etl-extract-school-zones
.PHONY: etl-tile-sal etl-tile-iso etl-tile-ptv etl-tile-school-zones
.PHONY: etl-forecast-bake etl-forecast-gate
.PHONY: etl-publish etl-status etl-all etl-all-extract etl-all-publish etl-all-tile
.PHONY: dev-explore agentic-dev-explore build-explore test-e2e-explore
.PHONY: port-debug port-clean agentic-port-clean

# =============================================================================
# Port Configuration
# =============================================================================
DEV_PORT ?= 5473
AGENTIC_DEV_PORT ?= 5474

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-26s\033[0m %s\n", $$1, $$2}'

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
# Dev servers (TypeScript) — block on `etl` so forecasts/tiles are current
# =============================================================================
# `dev` mounts the Explorer SPA (VITE_ENABLE_EXPLORE=true). Production builds
# (`make build`) intentionally drop the flag so the Explorer chain is tree-
# shaken out of the GitHub Pages bundle (T9.2 gate enforces this).

dev: install-ts etl ## Vite dev server (port 5473) — includes /explore + fresh ETL outputs
	@echo "==============================================================================="
	@echo "| Starting Vite dev server (HUMAN profile) — http://localhost:$(DEV_PORT)        |"
	@echo "==============================================================================="
	VITE_ENABLE_EXPLORE=true bun run dev -- --port $(DEV_PORT) --strictPort

agentic-dev: install-ts etl ## Vite dev server (port 5474) for AI agent dev / e2e
	@echo "==============================================================================="
	@echo "| Starting Vite dev server (AGENTIC profile) — http://localhost:$(AGENTIC_DEV_PORT)      |"
	@echo "==============================================================================="
	VITE_ENABLE_EXPLORE=true bun run dev -- --port $(AGENTIC_DEV_PORT) --strictPort

# Backwards-compat aliases — `dev` already sets VITE_ENABLE_EXPLORE.
dev-explore: dev ## Alias for `dev` (kept for muscle-memory; flag is now default)

agentic-dev-explore: agentic-dev ## Alias for `agentic-dev`

build: install-ts ## Production build (tsc -b && vite build) -> dist/ — Explorer tree-shaken out
	bun run build

build-explore: install-ts ## Production-shape build INCLUDING the Explorer chain (local sanity check)
	VITE_ENABLE_EXPLORE=true bun run build

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

test-e2e-explore: install-ts ## Playwright e2e against the Explorer SPA (flag on)
	VITE_ENABLE_EXPLORE=true bun run test:e2e -- e2e/explorer.spec.ts

e2e-report: install-ts ## Render e2e-screenshots/ into one review markdown (REPORT.md)
	bun run scripts/render-e2e-report.ts

# =============================================================================
# Inner-loop meta-targets — `make fix ci` is the canonical sequence
# =============================================================================

fix: install format lint-fix ## Auto-fix all fixable lint + format issues across both languages

ci: audit build format-check typecheck lint test test-e2e test-e2e-explore etl-forecast-gate ## Full CI gate (mirrors GitHub Actions)

# =============================================================================
# ETL pipeline — Make-native file rules
# =============================================================================
# Every `uv run -m etl <cmd>` is wrapped as a phony target whose body checks
# the mtime of the real output file (a parquet, a tile dir, or a sentinel).
# Re-running an etl target is a no-op when nothing upstream has changed.
#
#   etl-extracts → all extract subcommands (boundaries, rental_sales, cpi,
#                  hierarchies, isochrones, ptv)
#   etl-tiles    → all tile subcommands (sal, iso, ptv-lines, ptv-stops)
#   etl          → etl-extracts + etl-tiles + etl-forecast-bake
#
# `dev` depends on `etl` so the dev server is never started against stale
# (or absent) ETL outputs. First-run cost is unavoidable; thereafter, Make's
# mtime-based dependency tracking makes every subsequent invocation fast.

ETL_RUN := uv run -m etl
CONV := data/converted
PUBLIC := public/data
ORIG := data/originals

# --- Inputs (data lake) -------------------------------------------------------
# Note: the xlsx filenames under RENTAL_SALES_INPUT_DIR have spaces — Make's
# word-splitting can't represent them as dependency tokens. We depend on the
# directory itself instead: its mtime updates when files are added/removed.
# In-place xlsx overwrites won't auto-trigger a rebuild; force one with:
#   rm $(RENTAL_SALES_PARQUET) && make etl-extract-rental-sales
SAL_ZIP                  := $(ORIG)/boundaries/SAL_2021_AUST_GDA2020_SHP.zip
RENTAL_SALES_INPUT_DIR   := $(ORIG)/rental_sales
RENTAL_SALES_SCHEMA      := etl/rental_sales_schema.yaml
ISO_FOOT_DIR             := $(ORIG)/isochrones/foot

# --- Converted intermediates --------------------------------------------------
SAL_PARQUET              := $(CONV)/sal_2021_aust_gda2020.parquet
LGA_PARQUET              := $(CONV)/lga_2024_aust_gda2020.parquet
RENTAL_SALES_PARQUET     := $(CONV)/rental_sales.parquet
CPI_PARQUET              := $(CONV)/cpi_melbourne.parquet
ISO_FOOT_PARQUET         := $(CONV)/isochrones_foot.parquet

# --- Sentinels for table-in-DuckDB outputs ------------------------------------
IMPUTE_SENTINEL          := $(CONV)/.impute.sentinel
SAL_HIERARCHY_SENTINEL   := $(CONV)/.sal_hierarchy.sentinel
LGA_HIERARCHY_SENTINEL   := $(CONV)/.lga_hierarchy.sentinel
CLUSTER_LINKAGE_SENTINEL := $(CONV)/.cluster_linkage.sentinel
FORECASTS_META_JSON      := $(CONV)/forecasts_meta.json

# --- Published artifacts (consumed by the frontend) ---------------------------
LGA_GEOJSON              := $(PUBLIC)/selected_lga_2024_aust_gda2020.geojson
RENTAL_SALES_DUCKDB      := $(PUBLIC)/rental_sales.duckdb
TS_MODELS_DUCKDB         := $(CONV)/ts_models.duckdb
SAL_TILES_DIR            := $(PUBLIC)/tiles/suburbs
ISO_FOOT_5_TILES_DIR     := $(PUBLIC)/tiles/iso_foot_5
ISO_FOOT_15_TILES_DIR    := $(PUBLIC)/tiles/iso_foot_15

# --- School-zone catchments (DataVic 2026; ten levels) -----------------------
SCHOOL_ZONES_PARQUET     := $(CONV)/school_zones_2026.parquet
SCHOOL_ZONE_LEVELS       := primary secondary_year7 secondary_year8 secondary_year9 \
                            secondary_year10 secondary_year11 secondary_year12 \
                            standalone_juniorsec standalone_seniorsec standalone_singlesex
SCHOOL_ZONE_TILES_DIRS   := $(foreach l,$(SCHOOL_ZONE_LEVELS),$(PUBLIC)/tiles/school_zones_$(l))

# --- PTV (per-mode pattern rules) ---------------------------------------------
PTV_MODES                := metro_train metro_tram
PTV_LINE_PARQUETS        := $(foreach m,$(PTV_MODES),$(CONV)/ptv_lines_$(m).parquet)
PTV_STOP_PARQUETS        := $(foreach m,$(PTV_MODES),$(CONV)/ptv_stops_$(m).parquet)
PTV_LINE_TILES_DIRS      := $(foreach m,$(PTV_MODES),$(PUBLIC)/tiles/ptv_lines_$(m))
PTV_STOP_TILES_DIRS      := $(foreach m,$(PTV_MODES),$(PUBLIC)/tiles/ptv_stops_$(m))

# =============================================================================
# Extracts
# =============================================================================

etl-extract-sal: $(SAL_PARQUET) ## SAL boundary zip -> parquet
$(SAL_PARQUET): $(SAL_ZIP) | install-py
	$(ETL_RUN) extract sal --input $< --output $@

etl-extract-rental-sales: $(RENTAL_SALES_PARQUET) ## Rental + sales xlsx -> parquet + duckdb
$(RENTAL_SALES_PARQUET): $(RENTAL_SALES_INPUT_DIR) $(RENTAL_SALES_SCHEMA) $(SAL_PARQUET) $(LGA_GEOJSON) | install-py
	$(ETL_RUN) extract rental-sales

# Coverage-matrix imputation (docs/specs/impute.md). Rewrites the parquet
# in place + CREATE-OR-REPLACEs the rental_sales DuckDB table with the
# observed+imputed union. Idempotent (strips prior imputed rows first).
# Every downstream rental_sales reader depends on the sentinel — NOT the
# raw parquet — so cpi / hierarchies / bake all see the imputed matrix.
etl-impute: $(IMPUTE_SENTINEL) ## Synthesise the 20 missing coverage-matrix cells into rental_sales
$(IMPUTE_SENTINEL): $(RENTAL_SALES_PARQUET) $(SAL_PARQUET) $(LGA_GEOJSON) | install-py
	$(ETL_RUN) impute
	@mkdir -p $(@D) && touch $@

# CPI has no file input (fetches via ABS SDMX-JSON). Attaches `cpi` table to
# rental_sales.duckdb; that duckdb must exist (rental-sales extract creates it).
# To force a re-fetch, delete $(CPI_PARQUET) then re-run.
etl-extract-cpi: $(CPI_PARQUET) ## ABS Melbourne CPI -> parquet (+ cpi table in duckdb)
$(CPI_PARQUET): $(IMPUTE_SENTINEL) | install-py
	$(ETL_RUN) extract cpi

etl-extract-sal-hierarchy: $(SAL_HIERARCHY_SENTINEL) ## SAL agglomerative hierarchy (G7) -> geographic_hierarchy + linkage_matrix
$(SAL_HIERARCHY_SENTINEL): $(SAL_PARQUET) $(IMPUTE_SENTINEL) | install-py
	$(ETL_RUN) extract sal-hierarchy
	@mkdir -p $(@D) && touch $@

etl-extract-lga-hierarchy: $(LGA_HIERARCHY_SENTINEL) ## LGA agglomerative hierarchy (G8)
$(LGA_HIERARCHY_SENTINEL): $(LGA_PARQUET) $(IMPUTE_SENTINEL) | install-py
	$(ETL_RUN) extract lga-hierarchy
	@mkdir -p $(@D) && touch $@

# Centroid-only HDBSCAN + EVoC hierarchical clustering over the target
# polygon subset (observed ∧ imputed). Writes `cluster_linkage` rows into
# rental_sales.duckdb + region_totals.json into public/data. Consumed by
# /explore/dendrogram (Cytoscape renderer) and /explore/overview.
etl-build-cluster-linkage: $(CLUSTER_LINKAGE_SENTINEL) ## HDBSCAN + EVoC centroid clusters -> cluster_linkage + region_totals.json
$(CLUSTER_LINKAGE_SENTINEL): $(IMPUTE_SENTINEL) $(LGA_GEOJSON) | install-py
	$(ETL_RUN) extract cluster-linkage
	@mkdir -p $(@D) && touch $@

etl-extract-iso: $(ISO_FOOT_PARQUET) ## Concat + dissolve foot isochrones -> parquet
$(ISO_FOOT_PARQUET): | install-py
	$(ETL_RUN) extract isochrones --input $(ISO_FOOT_DIR) --output $@

etl-extract-ptv: $(PTV_LINE_PARQUETS) $(PTV_STOP_PARQUETS) ## Extract PTV lines + stops (both modes) -> parquet
$(CONV)/ptv_lines_%.parquet: $(ORIG)/ptv/lines_within_union_%.geojson | install-py
	$(ETL_RUN) extract ptv-lines --mode $*
$(CONV)/ptv_stops_%.parquet: $(ORIG)/ptv/stops_with_commute_times_%.geojson | install-py
	$(ETL_RUN) extract ptv-stops --mode $*

# =============================================================================
# Tiles
# =============================================================================

etl-tile-sal: $(SAL_TILES_DIR) ## Tile SAL parquet -> MVT XYZ tree
$(SAL_TILES_DIR): $(SAL_PARQUET) | install-py
	$(ETL_RUN) tile sal --input $<

etl-tile-iso: $(ISO_FOOT_5_TILES_DIR) $(ISO_FOOT_15_TILES_DIR) ## Tile foot isochrone corridors (5min + 15min)
$(ISO_FOOT_5_TILES_DIR): $(ISO_FOOT_PARQUET) | install-py
	$(ETL_RUN) tile isochrone --duration 5
$(ISO_FOOT_15_TILES_DIR): $(ISO_FOOT_PARQUET) | install-py
	$(ETL_RUN) tile isochrone --duration 15

etl-extract-school-zones: $(SCHOOL_ZONES_PARQUET) ## DataVic 2026 school catchments -> merged parquet
$(SCHOOL_ZONES_PARQUET): | install-py
	$(ETL_RUN) extract school-zones

etl-tile-school-zones: $(SCHOOL_ZONE_TILES_DIRS) ## Tile each school-zone level into MVT
$(PUBLIC)/tiles/school_zones_%: $(SCHOOL_ZONES_PARQUET) | install-py
	$(ETL_RUN) tile school-zones --level $*

etl-tile-ptv: $(PTV_LINE_TILES_DIRS) $(PTV_STOP_TILES_DIRS) ## Tile PTV lines + stops (both modes) -> MVT
$(PUBLIC)/tiles/ptv_lines_%: $(CONV)/ptv_lines_%.parquet | install-py
	$(ETL_RUN) tile ptv-lines --mode $*
$(PUBLIC)/tiles/ptv_stops_%: $(CONV)/ptv_stops_%.parquet | install-py
	$(ETL_RUN) tile ptv-stops --mode $*

# =============================================================================
# Forecasts (G1-G6)
# =============================================================================
# Bake reads rental_sales + cpi + geographic_hierarchy from rental_sales.duckdb
# and writes the `forecasts` table back into it (plus ts_models.duckdb side-car
# and the forecasts_meta.json provenance file). The meta JSON is the natural
# sentinel — it's only written after a successful bake completes.

etl-forecast-bake: $(FORECASTS_META_JSON) ## Fit SARIMAX per series + bake forecasts (G1-G3)
$(FORECASTS_META_JSON): $(IMPUTE_SENTINEL) $(CPI_PARQUET) $(SAL_HIERARCHY_SENTINEL) $(LGA_HIERARCHY_SENTINEL) | install-py
	$(ETL_RUN) forecast bake

# Gates the *committed* rental_sales.duckdb — deliberately NOT dependent on
# $(FORECASTS_META_JSON), so `make ci` checks the artifact in the repo
# rather than triggering a 3-minute rebake. Re-bake explicitly with
# `make etl-forecast-bake` when the forecasts need refreshing.
etl-forecast-gate: install-py ## Post-bake sMAPE breach gate (G6) — checks committed artifact
	uv run -m etl.diagnostics_gate

# =============================================================================
# Legacy / utility ETL entry points
# =============================================================================

etl-publish: install-py ## Publish full SAL parquet -> single GeoJSON (legacy / reference)
	$(ETL_RUN) publish sal

etl-status: install-py ## Show pipeline artifact status
	$(ETL_RUN) status

etl-all: install-py ## Run the full ETL pipeline via Python orchestrator (subprocess-isolated; bounded RAM)
	$(ETL_RUN) all

etl-all-extract: install-py ## Python-side: just the extract phase
	$(ETL_RUN) all --only extract

etl-all-publish: install-py ## Python-side: just the publish phase
	$(ETL_RUN) all --only publish

etl-all-tile: install-py ## Python-side: just the tile phase
	$(ETL_RUN) all --only tile

# =============================================================================
# Top-level ETL meta-targets — `make etl` is the canonical entry point
# =============================================================================

etl-extracts: etl-extract-sal etl-extract-rental-sales etl-impute etl-extract-cpi \
              etl-extract-sal-hierarchy etl-extract-lga-hierarchy \
              etl-build-cluster-linkage \
              etl-extract-iso etl-extract-ptv \
              etl-extract-school-zones ## Run every extract subcommand (no-op if up to date)

etl-tiles: etl-tile-sal etl-tile-iso etl-tile-ptv etl-tile-school-zones ## Tile every spatial intermediate (no-op if up to date)

etl: etl-extracts etl-tiles etl-forecast-bake ## Build every ETL output (no-op when current — dep of `dev`)

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

clean: ## Clean build artifacts, test outputs, deps, venv, tmp (preserves data/converted/ + public/data/)
	rm -rf dist coverage e2e-screenshots playwright-report test-results node_modules .venv tmp
