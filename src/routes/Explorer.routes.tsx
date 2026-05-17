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

const DEFAULT_LANDING = `lga/${DEFAULT_LGA_ID}`;

export const ExplorerTree = () => (
	<Routes>
		<Route element={<Explorer />}>
			<Route path="overview" element={<OverviewSummary />} />
			<Route path="sal/:id" element={<RegionExplorer kind="suburb" />} />
			<Route path="lga/:id" element={<RegionExplorer kind="lga" />} />
			<Route path="dendrogram/:tier" element={<DendrogramExplorer />} />
			{/* `to="sal"` is relative to this route's URL (/explore/dendrogram),
				so it resolves to /explore/dendrogram/sal. An absolute path
				or "dendrogram/sal" would double-prefix the path segment. */}
			<Route path="dendrogram" element={<Navigate to="sal" replace />} />
			<Route index element={<Navigate to={DEFAULT_LANDING} replace />} />
			<Route path="*" element={<Navigate to={DEFAULT_LANDING} replace />} />
		</Route>
	</Routes>
);
