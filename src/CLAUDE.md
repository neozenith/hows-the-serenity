# src/CLAUDE.md

Conventions for code under `src/`.

## Layout

```
src/
├── main.tsx           # ReactDOM.createRoot — the entry point Vite loads
├── App.tsx            # Top-level app component
├── App.css            # App-only CSS (rare — prefer Tailwind utilities)
├── index.css          # Global styles + Tailwind v4 directives + @theme tokens
├── vite-env.d.ts      # /// <reference types="vite/client" />
├── assets/            # Imported by source files (gets hashed into dist/)
├── components/
│   └── ui/            # shadcn/ui-owned primitives — overwritten by the shadcn CLI
└── lib/
    └── utils.ts       # cn() helper + other framework-agnostic utilities
```

If you add new directories, prefer:
- `components/` — feature-level React components (non-shadcn)
- `hooks/` — custom React hooks
- `pages/` or `routes/` — only if a router is introduced
- `lib/` — pure TypeScript utilities, no JSX

## Imports

Use the `@/*` alias for anything in `src/` — never reach across directories with `../../`:

```tsx
// good
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// bad
import { Button } from "../../components/ui/button"
```

Static assets imported as modules get fingerprinted at build time:

```tsx
import logo from "@/assets/logo.svg"
<img src={logo} alt="" />
```

Files in `/public/` (one level up) are copied verbatim and referenced by absolute path (`/favicon.ico`); use `/public` only for files that need a stable URL or that aren't imported by source.

## Components

- **shadcn primitives** (`components/ui/`) are owned source — edit them, but know that re-running `bunx --bun shadcn@latest add <name>` will overwrite them
- **Application components** go alongside or one level up from where they're used; promote to `components/` once shared by 2+ callers
- Default to function components with hooks; do not introduce class components
- Co-locate component-specific tests as `Foo.test.tsx` next to `Foo.tsx`

## Styling

- Reach for Tailwind utilities first; use `cn()` from `@/lib/utils` to merge conditional classes
- Reusable variants → `class-variance-authority` (already a dependency, used by shadcn)
- Global tokens / custom colors → `@theme { ... }` in `index.css`, not a JS config file
- `App.css` exists but is rarely the right place — prefer Tailwind or `@theme`

## Testing

- **Unit tests** use Vitest. Globals (`describe`, `it`, `expect`) are enabled — no need to import them.
- jsdom is the default environment; component tests use `@testing-library/react`.
- Place tests next to source: `Button.tsx` ↔ `Button.test.tsx`.
- Run a single unit test file: `bun run test -- src/components/ui/button.test.tsx`.
- **Do not** import from `bun:test` here — that is bun's native test runner, not Vitest. This codebase uses Vitest for unit tests.
- **End-to-end tests** live in `/e2e/*.spec.ts` (sibling of `src/`), not under `src/`. They use Playwright. See the root `CLAUDE.md` for the slug-taxonomy pattern.

## TypeScript

- Strict mode is on, plus `noUnusedLocals`, `noUnusedParameters`, and `erasableSyntaxOnly`
- `verbatimModuleSyntax` is enabled — use `import type { Foo }` for type-only imports
- The `@/*` alias must be declared in `tsconfig.app.json` (where `tsc -b` reads from), not just `tsconfig.json`

## Don't do this

- Don't import from `node_modules/` paths directly — go through the package name
- Don't introduce a `tailwind.config.js` — Tailwind v4 is configured in CSS
- Don't drop `src/lib/utils.ts` — every shadcn component imports `cn` from it
- Don't add a router/state-management library reactively; ask before introducing one
