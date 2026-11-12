---
type: Architecture Decision
title: Record architecture decisions as okf-yaml records, not free-form markdown
description: Decisions are YAML records validated by a schema, with markdown generated from them
tags: [process, decisions]
status: accepted
accepted_on: 2026-11-12
provenance: TICKETING.md began requiring that a GH Issue's open questions cover only what the repo's ADRs cannot resolve, and the repo had no ADRs; the Maintainer chose okf-yaml over a single-file log or one markdown file per decision
enforced_in:
  - adrs/
  - docs/TICKETING.md
  - AGENTS.md
  - Makefile
generated: { by: human:maintainer, at: 2026-11-12T00:00:00Z }
---

<!-- GENERATED from ADR-0001 by okf_render.py. Do not edit; edit the .yml and regenerate. -->

## Decision

### The lens

#### Given

agents and the Maintainer check existing decisions before raising an open question on a GH Issue, so the records are read by tools and agents, not only by people

#### We prefer

YAML records validated against a JSON Schema with typed relations and generated markdown, over a single-file markdown log or one hand-written markdown file per decision

#### Because

a schema turns a missing or mistyped field into a failure, typed relations are checked both ways, and the audit gates CI, so the record set stays queryable and sound as it grows

#### Unless

the records stop being read by any tool or agent, at which point plain markdown is cheaper to keep

## Consequences

### Pros

- A malformed or edited-after-acceptance record fails `make adr-audit` instead of drifting silently.
- Agents can query decisions by field, and the generated graph shows how decisions relate.

### Cons

- Each decision is a YAML source plus generated markdown, and both must be committed together.
- The generator and audit are Python scripts with their own dependencies to keep in step with the skill upstream.
