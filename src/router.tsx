// Conditional router: production builds (VITE_ENABLE_EXPLORE unset) ship
// only the map route at `/`; local-only Explorer builds also mount
// `/explore/*` with the analyst SPA.
//
// The Explorer subtree is dynamically imported at module-load time when the
// flag is on. When the flag is off, the import call is never evaluated and
// Vite's tree-shaker drops the entire Explorer chain (layout, side-nav,
// data tables, DuckDB-WASM) from the production bundle.

import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import App from "./App";

// `import.meta.env.VITE_ENABLE_EXPLORE` is a string at runtime ("true"/"false"/
// undefined). Vite inlines it at build time, so the ternary below resolves
// statically and the falsy branch's import is dead-code-eliminated.
const EXPLORER_ENABLED = import.meta.env.VITE_ENABLE_EXPLORE === "true";

// Lazy-imported so Vite emits the Explorer chunk separately from the map
// route. When EXPLORER_ENABLED is false, this is never evaluated.
const ExplorerTree = EXPLORER_ENABLED
	? lazy(() =>
			import("./routes/Explorer.routes").then((m) => ({
				default: m.ExplorerTree,
			})),
		)
	: null;

// `basename` must match Vite's `base` so `<Route path="/">` actually
// matches when the site is served from a sub-path (e.g. GitHub Pages at
// `/hows-the-serenity/`). Without this, BrowserRouter receives the
// full pathname `/hows-the-serenity/` and no route matches — React
// mounts but renders nothing, no error fires, and the page stays blank.
// Vite injects import.meta.env.BASE_URL with the trailing slash; strip
// it so the basename is `/hows-the-serenity` (BrowserRouter expects
// no trailing slash).
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "");

export const Router = () => (
	<BrowserRouter basename={BASENAME}>
		<Routes>
			<Route path="/" element={<App />} />
			{ExplorerTree && (
				<Route
					path="/explore/*"
					element={
						<Suspense
							fallback={
								<div className="p-4 text-sm text-neutral-500">
									Loading Explorer…
								</div>
							}
						>
							<ExplorerTree />
						</Suspense>
					}
				/>
			)}
		</Routes>
	</BrowserRouter>
);
