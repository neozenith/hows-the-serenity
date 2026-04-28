import { lazy, Suspense } from "react";
import type { RegionKind } from "@/lib/rental-sales-query";
import { overlayThemeClass, useOverlayTheme } from "@/lib/theme";
import { ErrorBoundary } from "./ErrorBoundary";

// Lazy import — Plotly + the rental-sales query module land in their own
// chunk that only downloads when the user first clicks a region. Without
// this the eager bundle gains ~700 KB. Wrapped in an ErrorBoundary so a
// failed chunk load OR a Plotly render exception doesn't crash the App.
const SuburbPlot = lazy(() => import("./SuburbPlot"));

// Generic selection — covers both SAL suburbs and LGAs. The `kind`
// discriminator drives the badge label and the rental-sales query.
export type RegionSelection = {
	kind: RegionKind;
	name: string;
	code: string;
};

// Backwards-compatible alias. Existing consumers (and the
// `__htsSelectSuburb`/`__htsSelectRegion` test hooks) reference
// `SuburbSelection` as the historical name; keep it pointing at the
// generalized type so the rename ripples cleanly.
export type SuburbSelection = RegionSelection;

const KIND_BADGE: Record<RegionKind, string> = {
	suburb: "SAL",
	lga: "LGA",
};

export const SuburbPlotPanel = ({
	selection,
	onClose,
}: {
	selection: RegionSelection | null;
	onClose: () => void;
}) => {
	const { theme } = useOverlayTheme();
	if (!selection) return null;
	return (
		<aside
			className={[
				"-translate-x-1/2 absolute bottom-4 left-1/2 z-10",
				"w-[min(900px,calc(100vw-32px))] rounded-md px-3 py-2 text-sm shadow-md backdrop-blur",
				"bg-white/95 dark:bg-neutral-900/90",
				overlayThemeClass(theme),
			].join(" ")}
		>
			<header className="mb-1 flex items-center justify-between gap-2">
				<h2 className="font-semibold text-neutral-900 dark:text-neutral-50">
					{selection.name}
					<span className="ml-1.5 font-normal text-neutral-500 text-xs dark:text-neutral-400">
						{KIND_BADGE[selection.kind]} {selection.code}
					</span>
				</h2>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close region plot"
					className="cursor-pointer rounded px-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
				>
					<span aria-hidden="true">×</span>
				</button>
			</header>
			<ErrorBoundary>
				<Suspense
					fallback={
						<div className="px-2 py-8 text-xs text-neutral-500 dark:text-neutral-400">
							Loading chart…
						</div>
					}
				>
					<SuburbPlot region={selection} />
				</Suspense>
			</ErrorBoundary>
		</aside>
	);
};
