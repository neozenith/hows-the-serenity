# Documentation Conventions

How this repository organises its documentation.
Agents and humans: consult this before creating, moving, or renaming any doc.

Lines marked *(defaulted)* came from the librarian's `standard` flavour rather than from what the repo already did; the Maintainer may veto them.

## Dialect

- **Flavour:** `standard`. The repo ships two languages (TypeScript, Python), keeps flat topic folders under `docs/`, and nests agent files below the root.
- **Docs taxonomy:** flat topic folders under `docs/` (`specs/`, `context/`), plus process docs at `docs/` top level. Diátaxis buckets are not used.
- **Glossary:** `docs/GLOSSARY.md` in the librarian glossary shape: four-line intro, one relationship diagram, one alphabetical H2 per Title Case term, new terms added in the same change.
- **ADR layout:** `okf-yaml` (records authored in `adrs/NNNN-slug.yml`, markdown generated). Ids are `ADR-NNNN`.
- **ADR generated paths:** `adrs/*.md`, `adrs/index.md`, `adrs/graph.json`, `adrs/graph.html`.
- **ADR regenerate / audit:** `make adrs` / `make adr-audit`.
- **Agent files:** `AGENTS.md` is canonical; a `CLAUDE.md` beside each holds only `@AGENTS.md`. Nested pairs in `src/` and `.github/` carry subtree rules.
- **Coding standards:** `docs/CODING_STANDARDS.md`, one section per language, each tenet pointing at its enforcing tool.
- **Ticketing:** `docs/TICKETING.md` defines GH Issues, branches, PRs and completion rules.
- **Changelog:** not used. *(defaulted: required at the first external consumer)*
- **Proposals/RFCs:** not used. *(defaulted)*

## Layout map

| Path | Charter (what belongs here) | Audience | Changes when |
|------|-----------------------------|----------|--------------|
| `README.md` | Orientation, requirements, data acknowledgements, routing to CONTRIBUTING | Consumers | Purpose or entry points change |
| `CONTRIBUTING.md` | Setup, build/test, PR workflow; points at CODING_STANDARDS and TICKETING | Contributors | Dev workflow changes |
| `AGENTS.md` | Agent invariants, commands and pointers; no restated conventions | Agents | Commands or hard boundaries change |
| `CLAUDE.md` (every directory with an `AGENTS.md`) | Exactly `@AGENTS.md` | Claude Code | Never |
| `src/AGENTS.md` | Rules binding only `src/` | Agents | Frontend conventions change |
| `.github/AGENTS.md` | Rules binding only workflows and repo metadata | Agents | CI or deploy model changes |
| `ARCHITECTURE.md` | System architecture overview | Both | Architecture changes |
| `LICENSE` | MIT licence | Everyone | Never |
| `adrs/` | Immutable accepted decisions (okf-yaml source + generated views) | Both | A binding decision is made |
| `docs/CONVENTIONS.md` | This file: the documentation dialect | Both | A doc convention is adopted or retired |
| `docs/CODING_STANDARDS.md` | How code is written; tenets mapped to tools per language | Contributors + Agents | A coding convention is adopted or retired |
| `docs/GLOSSARY.md` | Ubiquitous language: one canonical term per concept | Both | A domain term enters code or conversation |
| `docs/TICKETING.md` | GH Issue, branch, PR and completion conventions | Both | Ticketing workflow changes |
| `docs/specs/` | Feature and algorithm specifications | Contributors + Agents | A feature is designed or revised |
| `docs/context/` | Project history and background | Both | Context worth keeping is learned |
| `prototypes/<name>/` | Self-contained experiments with their own docs and diagrams | Contributors | A prototype is built or retired |

## Naming

- Root and `docs/` meta-files: UPPERCASE (`README.md`, `CONTRIBUTING.md`, `GLOSSARY.md`, `TICKETING.md`, …).
- Topic docs inside `docs/` subfolders: lowercase; kebab-case for new files *(defaulted: existing `docs/specs/` files use snake_case and are tolerated rather than churned)*.
- Point-in-time docs (findings, session notes): suffix `-YYYY-MM-DD` *(defaulted)*.
- ADR records: `adrs/NNNN-slug.yml`, 4-digit zero-padded.

## Pointers

- ADR directory: `adrs/`
- ADR index: `adrs/index.md`
- Docs site source: none
- Diagram conventions: Mermaid, linted with `bunx @jpeakai/mermaidjs-lint`

## Required cross-links

- Root `AGENTS.md` → this file, → `adrs/` with "check existing decisions before raising an open question", → `docs/CODING_STANDARDS.md`.
- Root `AGENTS.md` → `docs/GLOSSARY.md` with both standing instructions: use canonical terms for all naming; add new domain terms in the same change.
- `README.md` → `CONTRIBUTING.md`.
- `CONTRIBUTING.md` → `docs/CODING_STANDARDS.md`.
- `docs/TICKETING.md` → `docs/GLOSSARY.md` and `adrs/index.md`.

## Split/merge triggers

- `docs/` adopts Diátaxis folders when it passes ~10 topic files that mix genres. *(defaulted)*
- `adrs/` gains scoped logs beside any subtree with 3+ decisions of its own. *(defaulted)*
- `docs/GLOSSARY.md` splits into per-domain sections or files at ~100 terms, or when its diagram can no longer stay under the 50-node lint limit.
