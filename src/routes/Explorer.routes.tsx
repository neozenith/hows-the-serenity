// Explorer route tree.
//
// Lazy-imported by `router.tsx` only when the Explorer is enabled at
// build time (VITE_ENABLE_EXPLORE=true). Two pages, both rendered by the
// same component with a different `kind`:
//
//   /explore/sal/:id  → the rental + sales plots for a single SAL
//   /explore/lga/:id  → the rental + sales plots for a single LGA
//
// /explore (no id) and any other unknown sub-path redirect to Melbourne
// LGA — every LGA has data, so we always land on something renderable.

import { Navigate, Route, Routes } from "react-router-dom";

import { DendrogramExplorer } from "@/components/explorer/DendrogramExplorer";
import { OverviewSummary } from "@/components/explorer/OverviewSummary";
import {
	DEFAULT_LGA_ID,
	RegionExplorer,
} from "@/components/explorer/RegionExplorer";
import { Explorer } from "./Explorer";

// Absolute targets (still basename-relative): React Router v7 resolves
// relative paths inside a splat (`*`) route against the full URL, so a
// relative redirect from the catch-all would keep matching itself.
const DEFAULT_LANDING = `/explore/lga/${DEFAULT_LGA_ID}`;

export const ExplorerTree = () => (
	<Routes>
		<Route element={<Explorer />}>
			<Route path="overview" element={<OverviewSummary />} />
			<Route path="sal/:id" element={<RegionExplorer kind="suburb" />} />
			<Route path="lga/:id" element={<RegionExplorer kind="lga" />} />
			<Route path="dendrogram/:tier" element={<DendrogramExplorer />} />
			<Route
				path="dendrogram"
				element={<Navigate to="/explore/dendrogram/sal" replace />}
			/>
			<Route index element={<Navigate to={DEFAULT_LANDING} replace />} />
			<Route path="*" element={<Navigate to={DEFAULT_LANDING} replace />} />
		</Route>
	</Routes>
);
