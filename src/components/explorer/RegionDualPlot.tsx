// Stacked rental + sales + yield charts for a single SAL/LGA selection —
// the /explore page's primary content. All three panels share the same
// RegionSelection; each mounts a pinned SuburbPlot. SuburbPlot's
// internal DuckDB query returns rental + sales in one round-trip, so
// even though we mount it three times the database is only hit ~3x
// (per-mount queries), and the plotly bundle is shared via the lazy
// chunk.
//
// A top-level "Source" toggle above the panels lets the analyst scope
// what kind of data each chart shows (observed only / + imputed /
// + forecast / all). The selection lives in the `?sources=` URL param
// via the shared SourceFilterChips component, so a pasted /explore
// link reproduces what was on screen. The map's SuburbPlotPanel
// mounts the same component (compact variant) against the same URL
// param, so a filter chosen on either surface persists across routes.

import { lazy, Suspense } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
	SourceFilterChips,
	useSourceFilter,
} from "@/components/SourceFilterChips";
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

export const RegionDualPlot = ({ region }: { region: RegionSelection }) => {
	const [filter, setFilter] = useSourceFilter();
	return (
		<div className="flex flex-col gap-4 p-3" data-testid="region-dual-plot">
			<SourceFilterChips filter={filter} onChange={setFilter} size="md" />
			<Panel heading="Rental" testid="region-rental-panel">
				<SuburbPlot region={region} view="rental" sourceFilter={filter} />
			</Panel>
			<Panel heading="Sales" testid="region-sales-panel">
				<SuburbPlot region={region} view="sales" sourceFilter={filter} />
			</Panel>
			<Panel heading="Yield ratio" testid="region-yield-panel">
				<SuburbPlot region={region} view="yield" sourceFilter={filter} />
			</Panel>
		</div>
	);
};
