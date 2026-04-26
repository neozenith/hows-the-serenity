# CLAUDE.md

Project-specific guidance for Claude Code working in this repository.

## What this is

A single-page Vite + React + TypeScript application with Tailwind CSS v4, shadcn/ui components, Vitest for unit tests, and Playwright for end-to-end tests. The runtime and package manager is **bun** (not npm). Lint + format is handled by **Biome** (single tool, replacing ESLint + Prettier). Pushes to `main` deploy to GitHub Pages via `actions/deploy-pages` (artifact-based — no `gh-pages` branch). Tags additionally upload a release asset.

## Tech stack

- **Runtime / package manager**: bun (1.3+)
- **Build**: Vite 8
- **Framework**: React 19 + TypeScript (strict, with project references)
- **Styling**: Tailwind CSS v4 via `@tailwindcss/vite` (no `tailwind.config.*`; configuration lives in `src/index.css`)
- **UI primitives**: shadcn/ui — components live in `src/components/ui/` and are owned, not imported from a package
- **Lint + format**: Biome (`biome.json`); replaces ESLint and Prettier
- **Audit**: `bun audit --audit-level=high` runs as part of `make lint`
- **Unit tests**: Vitest + jsdom + Testing Library (scoped to `src/**/*.{test,spec}.{ts,tsx}`)
- **E2e tests**: Playwright (`e2e/*.spec.ts`); see "E2e testing pattern" below
- **Path alias**: `@/*` → `src/*` (declared in both `tsconfig.json` and `tsconfig.app.json`)

## Directory map

```
.
├── Makefile                   # Single command-and-control surface — start here
├── biome.json                 # Lint + format config (Biome)
├── playwright.config.ts       # E2e config (auto-starts dev server on agentic port)
├── .github/workflows/         # CI build + e2e + artifact upload (see .github/CLAUDE.md)
├── e2e/                       # Playwright specs (see "E2e testing pattern")
├── e2e-screenshots/           # E2e test artifacts (gitignored)
├── src/                       # Application source (see src/CLAUDE.md)
├── public/                    # Static assets copied verbatim into dist/
├── dist/                      # Build output — gitignored, produced by `bun run build`
├── index.html                 # Vite entry — script tag points at src/main.tsx
├── vite.config.ts             # Vite + Vitest + Tailwind plugin + @ alias
├── components.json            # shadcn/ui config (do not edit by hand)
├── tsconfig.json              # Project references root + paths
├── tsconfig.app.json          # App compiler options + paths (the one that matters at build time)
├── tsconfig.node.json         # Vite/tooling files compiler options
├── bun.lock                   # Bun's text lockfile — commit it, never delete it
└── package.json
```

## Commands

The Makefile is the canonical entry point — it encodes the project's quality DAG. Run `make help` to see the auto-discovered target list.

### Canonical inner-loop: `make fix ci`

After laying down code, run **`make fix ci`**. The two phases:

1. **`make fix`** — meta-target with no recipe, just deps `install format lint-fix`. Autoformats every file (Biome `format --write`) then applies all auto-fixable lint issues (`biome lint --write --unsafe`). The DAG is the program; each leaf is independently runnable.
2. **`make ci`** — strict gate: `audit build format-check typecheck lint test test-e2e`. `audit` and `format-check` are listed explicitly even though `lint` covers them transitively, so future trimming of `lint`'s deps doesn't silently weaken the CI gate. Make's dep dedup ensures each target runs at most once.

If `fix` couldn't autofix something, `ci`'s `lint` step catches it. Clean signal, every time.

### Key targets

| Target | Purpose |
|--------|---------|
| `make install` | `bun install` — idempotent, gated by a `node_modules/.bun_deps` sentinel file |
| `make dev` | Vite dev server on **port 5173** (human profile) |
| `make agentic-dev` | Vite dev server on **port 5174** (AI agent profile) |
| `make build` | Production build (`tsc -b && vite build`) → `dist/` |
| `make preview` | Preview the built bundle |
| `make audit` | `bun audit --audit-level=high` |
| `make format` | Biome `format --write` (autofix whitespace) |
| `make format-check` | Biome `format` read-only — fails if anything would be reformatted |
| `make lint` | `biome ci` + `bun audit` (read-only; **fails on warnings/info too**, not just errors) |
| `make lint-fix` | Biome `lint --write --unsafe` — autofix lint findings only, leaves formatting alone |
| `make fix` | Meta-target = `format` + `lint-fix` — applies all fixable lint + format issues |
| `make typecheck` | `tsc -b` (project references; leaf tsconfigs set `noEmit: true`) |
| `make test` | Vitest single-pass with `--passWithNoTests` |
| `make test-watch` | Vitest watch mode |
| `make test-ui` | `@vitest/ui` dashboard |
| `make test-e2e` | Playwright e2e (auto-starts dev server on port 5174) |
| `make test-e2e-ui` | Playwright interactive UI mode |
| `make ci` | Strict gate: `audit → build → format-check → typecheck → lint → test → test-e2e` |
| `make port-debug` | Show what's bound to ports 5173 / 5174 |
| `make port-clean` | Kill the human-port (5173) holder |
| `make agentic-port-clean` | Kill the agentic-port (5174) holder |
| `make clean` | Remove all build outputs, test artifacts, and `node_modules/` |

Add a shadcn component (no make target — invoke directly):

```bash
bunx --bun shadcn@latest add <name>
```

### Why `dev` and `agentic-dev` are split

The two targets bind different ports (5173 vs 5174) so a human running `make dev` and an AI agent running `make agentic-dev` can both develop simultaneously without port collisions. `port-clean` and `agentic-port-clean` are likewise split — each role only kills its own port. Both servers use `--strictPort` so a misconfigured collision fails loudly instead of silently picking the next free port.

Playwright's `webServer` is configured to use the **agentic port (5174)** so a human can keep `make dev` running on 5173 while `make test-e2e` runs in parallel.

Always run from the project root — never `cd` into subdirectories. If you need to run a one-off bun command, use `bun --cwd <subdir>`, not `cd <subdir> && bun ...`.

## E2e testing pattern (slug taxonomy)

`e2e/routes.spec.ts` follows the **slug taxonomy** pattern from `claude-code-sessions/frontend/e2e/filters.spec.ts`. The shape:

- **Axes** — each axis is a `const` array of `{ id, slug, ... }` records. `id` is numeric for lexicographic sort of artifact filenames; `slug` is a URL-safe lowercase identifier; additional fields (`name`, `path`) carry test-time data. Currently this project has two axes:
  - `ENGINES` — single `default` entry; expand when running tests against multiple build profiles or browsers
  - `SECTIONS` — the site map; one entry per route (`{ id, slug, name, path }`)
- **`COVERAGE_MATRIX`** — declarative spec of which permutations to test. Edit this to expand or thin coverage; nested for-loops at the bottom of the file generate one Playwright `test()` per matrix entry.
- **Slug builder** — `screenshotSlug(engine, section)` produces `E{id}_{ENGINE}-S{id}_{SECTION}` (e.g. `E01_DEFAULT-S00_HOME`). Pads ids to two digits so 10+ entries still sort correctly.
- **`collectTestIO(page)`** — captures console output (errors → assertion fail), page errors, and per-request network timing. On `writeLog(slug)` it emits paired artifacts:
  - `e2e-screenshots/<slug>.png` — full-page screenshot
  - `e2e-screenshots/<slug>.log` — console + page-error stream
  - `e2e-screenshots/<slug>.network.json` — start-offset-sorted timing summary, ready for Gantt visualization

To add a route to the smoke suite: append `{ id, slug, name, path }` to `SECTIONS`. Done. To add a filter axis later (time range, viewport, locale): copy the `ENGINES`/`SECTIONS` shape and extend the permutation loop.

## bun-specific gotchas

- **Use `bun run test`, not `bun test`** — the latter invokes bun's built-in test runner. This project uses Vitest, which is wired through the npm-style script.
- **Use `bun add` / `bun add -d`, never `npm install` or `npx install`** — they produce a different lockfile and break `bun install`'s integrity check.
- **`bunx --bun <pkg>`** forces the wrapped CLI to run on bun's runtime instead of node. Use it for shadcn (`bunx --bun shadcn@latest add ...`), tsc (`bunx --bun tsc -b`), Biome (`bunx --bun biome check`), and Playwright (`bunx --bun playwright install`).
- **`bun.lock`** is bun's text lockfile (Bun ≥ 1.2). Commit it. Never recreate from scratch — let `bun add` / `bun install` update it incrementally.
- **`bun audit --audit-level=high`** is the canonical security check; it queries the npm advisory database. Wired into `make lint` so CI fails on new high+ severity vulnerabilities.

## Path aliases

Both `tsconfig.json` and `tsconfig.app.json` declare `@/*` → `./src/*`. Both are required: the root tsconfig satisfies editors and shadcn's CLI; the app tsconfig is what `tsc -b` actually consults during the build. If you add another alias, add it in **both** files and in `vite.config.ts`'s `resolve.alias`.

`baseUrl` is intentionally absent — it is deprecated in TypeScript 6+ and `paths` resolves relative to each tsconfig's location.

## Tailwind v4 notes

- Configuration is CSS-first: design tokens, `@theme`, and plugin settings live in `src/index.css`
- There is no `tailwind.config.js`; do not create one
- The Vite plugin (`@tailwindcss/vite`) does the work that `postcss` + `autoprefixer` used to do in v3
- Biome has `tailwindDirectives: true` enabled in `biome.json` so `@apply`, `@tailwind`, `@theme`, etc. don't trip the CSS parser

## shadcn/ui notes

- Components are generated into `src/components/ui/` and are part of this repo's source — edit them freely
- `src/lib/utils.ts` exports the `cn()` helper used by every shadcn component; do not delete it
- Re-running `bunx --bun shadcn@latest add <name>` is safe and idempotent unless you've modified the file
- The shadcn CLI auto-detects bun via `bun.lock` and uses `bun add` for new dependencies

## Biome notes

- One tool replaces ESLint + Prettier — do not add either back; Biome's lint and format rule sets fight ESLint/Prettier on the same files
- `biome.json` config: tab indent, double quotes, recommended rules, organize imports on
- Excludes `.claude/`, `dist/`, `coverage/`, `e2e-screenshots/`, `playwright-report/`, `test-results/`, `tmp/`
- The `.claude/` exclusion is required because `.claude/skills/mermaidjs_diagrams/scripts/` ships its own `biome.json`; without the exclude Biome refuses to run with a "nested root configuration" error

### Strict no-warnings policy

**Every Biome diagnostic — error, warning, OR info — is a CI failure.** This project does not tolerate "yellow" lint output that lingers indefinitely. The mechanism:

- The `lint` package.json script is `biome ci .`, not `biome lint .`. `biome lint` only exits non-zero on errors (severity = error). `biome ci` exits non-zero on **anything** Biome reports — including info-level diagnostics (e.g. `useNodejsImportProtocol`) and format drift
- The GitHub Actions workflow runs the same `bunx --bun biome ci .` directly, so local `make lint` ≡ CI behavior. No "passes locally but fails in CI" surprises
- If you hit a finding you can't fix immediately, do NOT lower the rule severity to "info" or disable it project-wide. Either: (a) fix it, (b) add a per-file `// biome-ignore lint/<rule>: <reason>` with a written justification, or (c) discuss with the team before changing `biome.json`

For autofixing, use `make fix` — a meta-target that depends on `format` + `lint-fix`. It applies every Biome auto-fix the codebase has — safe ones (whitespace, organize imports) and unsafe ones (e.g. rewriting `import path from "path"` → `"node:path"`). Review the diff before committing. The canonical inner-loop is `make fix ci`.

## CI / deploy model

`.github/workflows/build.yml` has two jobs:

- **`build`** runs on every push, PR, and tag. Pipeline: install → audit → biome ci → build → unit tests → install Playwright browsers (cached) → e2e → upload artifact.
- **`deploy-pages`** runs only on push to `main`. It rebuilds with the Pages base path forwarded via `PAGES_BASE_PATH`, then deploys via `actions/deploy-pages@v5`.

Outputs:

1. **Workflow artifact** (every run): `dist/` zipped and attached to the workflow run, named `site-dist-<run_id>-<sha>`, retained 30 days
2. **GitHub Pages** (push to `main`): live at `https://<owner>.github.io/<repo>/` (URL printed in the deploy job summary). Uses `actions/deploy-pages` — artifact-based, **not** a `gh-pages` branch
3. **Release asset** (tag pushes only): on `v*` tags, the same zip is uploaded to the GitHub Release
4. **E2e failure bundle** (only on e2e failure): `e2e-screenshots/`, `playwright-report/`, and `test-results/` uploaded as `e2e-failures-<run_id>-<sha>` (14-day retention)

### One-time Pages setup

In **Repo Settings → Pages**, set **Source: GitHub Actions**. The deploy job will register the `github-pages` environment automatically on first run. If the repo lives at `https://<owner>.github.io/<repo>/`, Vite's `base` is set automatically by `actions/configure-pages`'s `base_path` output (read by `vite.config.ts` from `PAGES_BASE_PATH`).

### `vite.config.ts` and `base`

The config reads `process.env.PAGES_BASE_PATH ?? "/"` so:
- Local dev / `make build` → `base: "/"`
- Pages deploy → `base: "/<repo>/"` (or `"/"` if a custom domain is configured)

Don't hard-code a base path; always go through the env var so a future custom-domain switch is a one-flag flip in repo settings.
