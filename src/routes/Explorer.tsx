// Explorer route layout — owns the theme provider, the persistent side
// panel, and the DuckDB-readiness gate around the route Outlet.
//
// Why the layout has its own ThemeProvider: the map (App.tsx) has one
// for its floating-widget overlays, but /explore/* is a separate
// react-router subtree (lazy-mounted by router.tsx) and never renders
// inside App, so it needs its own provider. The provider stores theme
// in the same `hts:overlay-theme` localStorage key, so a user's choice
// follows them between the map and the analyst surface.
//
// The DuckDB gate stays: every sub-page queries on mount, and the
// earlier fire-and-forget design produced "DuckDB not initialised yet"
// errors before initRentalDb resolved. Gating the Outlet means a
// sub-page only ever mounts against a ready connection.

import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { ExplorerSideNav } from "@/components/explorer/ExplorerSideNav";
import { initRentalDb } from "@/lib/duckdb";
import { overlayThemeClass, ThemeProvider, useOverlayTheme } from "@/lib/theme";

const ExplorerLayout = () => {
	const { theme } = useOverlayTheme();
	const [dbReady, setDbReady] = useState(false);
	const [dbError, setDbError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		initRentalDb({})
			.then(() => {
				if (!cancelled) setDbReady(true);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setDbError(err instanceof Error ? err.message : String(err));
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div
			data-testid="explorer-root"
			className={[
				overlayThemeClass(theme),
				// h-screen + overflow-hidden caps the page at the viewport so each
				// inner panel (kind side-nav, region picker, dual-plot content)
				// can own its own scroll context. With min-h-screen the page
				// would grow with the picker's 760-row list and nothing would
				// scroll internally.
				"flex h-screen overflow-hidden bg-neutral-50 text-neutral-900",
				"dark:bg-neutral-950 dark:text-neutral-100",
			].join(" ")}
		>
			<ExplorerSideNav />
			<main className="min-h-0 flex-1 overflow-hidden">
				{dbError && (
					<div
						className="p-4 text-red-500 text-sm"
						data-testid="explorer-db-error"
					>
						DuckDB initialisation failed: {dbError}
					</div>
				)}
				{!dbReady && !dbError && (
					<div
						className="p-4 text-neutral-500 text-sm"
						data-testid="explorer-db-loading"
					>
						Initialising DuckDB…
					</div>
				)}
				{dbReady && <Outlet />}
			</main>
		</div>
	);
};

export const Explorer = () => (
	<ThemeProvider>
		<ExplorerLayout />
	</ThemeProvider>
);
