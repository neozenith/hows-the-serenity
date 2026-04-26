# .github/CLAUDE.md

Conventions for GitHub Actions workflows and repo metadata in this directory.

## Deploy model: artifact-based, not branch-based

This repo deliberately does **not** use a `gh-pages` branch (the legacy Pages model where you push your built files to a separate branch). Instead, every artifact is *uploaded* — either as a workflow artifact, a release asset, or via `actions/deploy-pages` which consumes a special Pages artifact and serves it. None of these require a long-lived deploy branch.

| Mechanism | When | Retention | How to retrieve / view |
|-----------|------|-----------|------------------------|
| Workflow artifact (`site-dist-*`) | Every workflow run (push, PR, manual) | 30 days | Workflow run summary → "Artifacts" panel, or `gh run download <run-id>` |
| GitHub Pages | Push to `main` only | Latest deploy is live; previous bundles retained per Pages limits | `https://<owner>.github.io/<repo>/` (URL printed in the deploy job summary) |
| Release asset | Tag pushes matching `v*` | Permanent (until release deleted) | Release page, or `gh release download <tag>` |
| E2e failure bundle (`e2e-failures-*`) | Only on e2e failure | 14 days | Workflow run summary → "Artifacts" panel |

If you change the hosting target, do not introduce a `gh-pages` or `dist` branch — extend the workflow to push the bundle to the actual hosting target (S3, R2, Cloudflare Pages direct upload, etc.). The artifact-based pattern is the rule.

### One-time GitHub Pages setup

`actions/configure-pages` can auto-enable Pages for the repo on its first run, but the recommended one-time setup is:

1. Repo **Settings → Pages**
2. **Source**: GitHub Actions
3. (Optional) Custom domain — set in the same panel; updates the `base_path` returned to the workflow

The deploy job uses the `github-pages` environment (auto-created on first deploy). Required permissions are scoped at the job level: `pages: write` and `id-token: write` (for OIDC auth to Pages).

## Workflow file: `workflows/build.yml`

Two jobs: `build` always runs; `deploy-pages` only runs on push to `main`.

### `build` job

1. `actions/checkout@v6` — pull the source
2. `oven-sh/setup-bun@v2` — install bun
3. `bun install --frozen-lockfile` — reproducible install
4. `bun audit --audit-level=high` — fail on new high+ severity advisories
5. `bunx --bun biome ci .` — lint + format check (no auto-fix; CI mode)
6. `bun run build` — `tsc -b && vite build` (uses default `base: "/"`)
7. `bun run test --run --passWithNoTests` — Vitest single-pass
8. `actions/cache@v5` — restore Playwright browsers from `~/.cache/ms-playwright`
9. `bunx --bun playwright install --with-deps chromium` — install/update browsers
10. `bun run test:e2e` — Playwright runs against the Vite dev server it auto-starts
11. `actions/upload-artifact@v7` — upload `dist/` always; e2e artifacts only on failure
12. `gh release upload` — only on `v*` tags, attaches the zipped bundle to the matching Release

### `deploy-pages` job (push to main only)

Re-builds with the Pages base path (e.g. `/repo-name/`), then deploys.

1. `actions/checkout@v6`
2. `oven-sh/setup-bun@v2`
3. `bun install --frozen-lockfile`
4. `actions/configure-pages@v6` — outputs `base_path` (the URL prefix Pages will serve from)
5. `bun run build` with `PAGES_BASE_PATH=${{ steps.pages.outputs.base_path }}` — `vite.config.ts` reads this and sets Vite's `base` accordingly so all asset URLs are correctly prefixed
6. `actions/upload-pages-artifact@v5` — produces the special tarball Pages consumes (artifact name is fixed: `github-pages`)
7. `actions/deploy-pages@v5` — deploys; outputs the live URL into the run summary

The deploy job is gated on `github.event_name == 'push' && github.ref == 'refs/heads/main'` so PRs don't deploy.

### Action versions

Pinned to current major versions as of 2026-04. Bump majors during routine maintenance — minor/patch updates are safe to take automatically (Dependabot if enabled).

| Action | Version | Notes |
|--------|---------|-------|
| `actions/checkout` | `v6` | v6 is the current stable major |
| `actions/cache` | `v5` | For Playwright browser cache |
| `actions/upload-artifact` | `v7` | v7 changed retention defaults vs v3/v4 — re-read docs before downgrading |
| `actions/configure-pages` | `v6` | Auto-enables Pages and outputs `base_path` |
| `actions/upload-pages-artifact` | `v5` | Artifact name is fixed (`github-pages`); don't try to rename it |
| `actions/deploy-pages` | `v5` | Requires `pages: write` + `id-token: write` permissions |
| `oven-sh/setup-bun` | `v2` | Stable major; minor patches happen frequently |

### Why these specific choices

- **`bun audit --audit-level=high`** — queries the npm advisory database; fails the run on high+ vulnerabilities so they're surfaced at PR time, not at deploy time
- **`biome ci`, not `biome check --write`** — CI mode is read-only and produces structured error output. `--write` would mutate files in CI, which is wrong
- **`bun install --frozen-lockfile`** — fails the build if `bun.lock` is out of sync with `package.json` (the bun analog of `npm ci`)
- **`bun run test --run --passWithNoTests`** — Vitest defaults to watch mode; `--run` forces single-pass. `--passWithNoTests` keeps CI green when there are no test files yet
- **Playwright browser cache** — `~/.cache/ms-playwright` is keyed by `bun.lock` hash. Cache hits skip the multi-MB browser download; misses fall through to a fresh `playwright install`
- **`--with-deps chromium`** — installs Chromium plus Linux system libs; safer than relying on the Ubuntu runner's pre-installed shared libraries
- **E2e artifact upload is conditional on `if: failure()`** — successful runs don't waste artifact storage on screenshots no one will look at
- **Artifact name keyed by `${{ github.run_id }}-${{ github.sha }}`** — `upload-artifact@v4+` errors on duplicate names within a run; the run_id + sha combination guarantees uniqueness across re-runs and parallel jobs
- **`concurrency: cancel-in-progress`** — pushing a new commit cancels the previous run for the same ref
- **Workflow-level `permissions: contents: read`, job-level `contents: write`** — least-privilege at the workflow boundary, scoped escalation only for the job that needs `gh release upload`

### Triggers

- `push` on `main` and `v*` tags — main produces a workflow artifact; tags additionally produce a release asset
- `pull_request` — produces only a workflow artifact (and an e2e failure bundle if applicable)
- `workflow_dispatch` — enables manual runs from the Actions tab

## Bun-specific notes for CI

- **Do not call `bun test` in CI** — it runs bun's native test runner, not Vitest. Always use `bun run test`.
- **Do not run `bun install` without `--frozen-lockfile`** in CI — without the flag, bun will silently update `bun.lock`, defeating reproducibility.
- **Do not mix `setup-node` with `setup-bun`** unless you genuinely need both runtimes. For this Vite project, bun handles everything.
- **Do not call ESLint or Prettier directly** — Biome replaces both. The project rule is "pick ONE — do not combine Biome with ESLint/Prettier."

## What NOT to add to this directory

- `peaceiris/actions-gh-pages` or any third-party action that pushes to a `gh-pages` branch — that's the *legacy* branch-based model; we use `actions/deploy-pages` (artifact-based) instead
- A `gh-pages` or `dist` branch in the repo — modern Pages does not need one
- `actions/setup-node` alongside setup-bun — adds a second runtime for no reason
- ESLint or Prettier action wrappers — Biome handles both via `biome ci`
- A separate `release.yml` that duplicates the build — extend `build.yml` instead, or factor shared steps into a reusable workflow under `.github/workflows/_build.yml`

## Adding more workflows

Common candidates and naming:

- `workflows/codeql.yml` — GitHub's CodeQL scanner
- `workflows/dependabot-auto-merge.yml` — auto-merge minor/patch dependabot PRs
- `workflows/_install.yml` — reusable workflow factoring out the common bun/install/audit/biome steps once the workflow set grows

If a workflow grows past ~100 lines or shares steps with `build.yml`, factor common pieces into a reusable workflow (`.github/workflows/_install.yml` called via `uses: ./.github/workflows/_install.yml`).
