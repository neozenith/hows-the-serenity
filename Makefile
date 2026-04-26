.PHONY: help install dev agentic-dev build preview clean
.PHONY: audit format format-check lint lint-fix fix typecheck
.PHONY: test test-watch test-ui test-e2e test-e2e-ui ci
.PHONY: port-debug port-clean agentic-port-clean

# =============================================================================
# Port Configuration
# =============================================================================
# Human developer port (default Vite port).
DEV_PORT ?= 5173

# AI agent port (use for `agentic-dev` so it can run in parallel with `dev`).
AGENTIC_DEV_PORT ?= 5174

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# =============================================================================
# Installation
# =============================================================================
# Sentinel-file pattern: `bun install` only runs when package.json or bun.lock
# is newer than node_modules/.bun_deps. Every other target chains through
# `install` for cheap idempotence.

install: node_modules/.bun_deps ## Install dependencies (bun install, idempotent)

node_modules/.bun_deps: package.json bun.lock
	bun install
	@touch $@

# =============================================================================
# Human Developer Targets (default port 5173)
# =============================================================================

dev: install ## Run Vite dev server for human developers (port 5173)
	@echo "==============================================================================="
	@echo "| Starting Vite dev server (HUMAN profile)...                                 |"
	@echo "|                                                                             |"
	@echo "| http://localhost:$(DEV_PORT)                                                       |"
	@echo "|                                                                             |"
	@echo "| For AI agent development: make agentic-dev (port $(AGENTIC_DEV_PORT))                       |"
	@echo "==============================================================================="
	bun run dev -- --port $(DEV_PORT) --strictPort

# =============================================================================
# AI Agent Development Targets (port 5174)
# =============================================================================

agentic-dev: install ## Run Vite dev server for AI agent development (port 5174)
	@echo "==============================================================================="
	@echo "| Starting Vite dev server (AGENTIC CODING profile)...                        |"
	@echo "|                                                                             |"
	@echo "| http://localhost:$(AGENTIC_DEV_PORT)                                                       |"
	@echo "|                                                                             |"
	@echo "| For human development: make dev (port $(DEV_PORT))                                  |"
	@echo "==============================================================================="
	bun run dev -- --port $(AGENTIC_DEV_PORT) --strictPort

# =============================================================================
# Build & Preview
# =============================================================================

build: install ## Production build (tsc -b && vite build) -> dist/
	bun run build

preview: install ## Preview the built bundle locally
	bun run preview

# =============================================================================
# Code Quality
# =============================================================================
# Single tool for both lint and format: Biome. `lint` is read-only (strict —
# fails on warnings/info too); `format` modifies whitespace only; `fix` is the
# "make my code clean" target — applies all auto-fixable lint and format
# issues including unsafe ones.

audit: install ## Audit dependencies for known vulnerabilities (high+ severity)
	bun audit --audit-level=high

format: install ## Auto-format code (Biome format --write — modifies files)
	bun run format

format-check: install ## Format check only — fails if any file would be reformatted (no writes)
	bun run format-check

lint: install audit ## Strict check: Biome ci + audit (fails on warnings/info — matches CI)
	bun run lint

lint-fix: install ## Auto-fix lint findings only — leaves formatting alone (Biome lint --write --unsafe)
	bun run lint-fix

fix: install format lint-fix ## Auto-fix all fixable lint + format issues (Biome check --write --unsafe + audit)

typecheck: install ## TypeScript type check (tsc -b, no emit — leaf tsconfigs set noEmit:true)
	bunx --bun tsc -b

test: install ## Run Vitest unit tests once (passes if no test files yet)
	bun run test --run --passWithNoTests

test-ui: install ## Run Vitest with the @vitest/ui dashboard
	bun run test:ui

test-e2e: install ## Run Playwright e2e tests (auto-starts dev server on agentic port)
	bun run test:e2e

test-e2e-ui: install ## Run Playwright in interactive UI mode
	bun run test:e2e -- --ui

ci: audit build format-check typecheck lint test test-e2e ## Run all CI checks (typecheck → lint → unit tests → e2e)

# =============================================================================
# Port Management
# =============================================================================
# `port-clean` and `agentic-port-clean` are deliberately split so the human
# and the agent can each clean up their own port without disturbing the other.

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

clean: ## Clean up build artifacts, test outputs, deps, and tmp/
	rm -rf dist
	rm -rf coverage
	rm -rf e2e-screenshots
	rm -rf playwright-report
	rm -rf test-results
	rm -rf node_modules
	rm -rf tmp
