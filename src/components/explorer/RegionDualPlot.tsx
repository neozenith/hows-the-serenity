// Stacked rental + sales charts for a single SAL/LGA selection — the
// /explore page's primary content. Both panels share the same
// RegionSelection and each one mounts a pinned SuburbPlot. SuburbPlot's
// internal DuckDB query returns rental + sales in one round-trip, so
// even though we mount it twice the database is only hit ~2x (per-mount
// queries), and the plotly bundle is shared via the lazy chunk.
//
// The map's SuburbPlotPanel keeps using the tabbed SuburbPlot (limited
// real estate). This is the analyst surface where both views are wanted
// simultaneously.

import { lazy, Suspense } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { RegionSelection } from "@/lib/region";

const SuburbPlot = lazy(() => import("@/components/SuburbPlot"));

const Panel = ({
	heading,
	testid,
	children,
}: {
	heading: string;
	testid: string;
	children: React.ReactNode;
}) => (
	<section
		data-testid={testid}
		className="rounded-md border border-neutral-200 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
	>
		<h3 className="mb-2 font-medium text-neutral-700 text-sm dark:text-neutral-200">
			{heading}
		</h3>
		<ErrorBoundary>
			<Suspense
				fallback={
					<div className="px-2 py-8 text-xs text-neutral-500 dark:text-neutral-400">
						Loading chart…
					</div>
				}
			>
				{children}
			</Suspense>
		</ErrorBoundary>
	</section>
);

export const RegionDualPlot = ({ region }: { region: RegionSelection }) => (
	<div className="flex flex-col gap-4 p-3" data-testid="region-dual-plot">
		<Panel heading="Rental" testid="region-rental-panel">
			<SuburbPlot region={region} view="rental" />
		</Panel>
		<Panel heading="Sales" testid="region-sales-panel">
			<SuburbPlot region={region} view="sales" />
		</Panel>
		<Panel heading="Yield ratio" testid="region-yield-panel">
			<SuburbPlot region={region} view="yield" />
		</Panel>
	</div>
);
