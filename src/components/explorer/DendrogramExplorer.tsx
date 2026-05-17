// Cluster inspector for the agglomerative hierarchy. One page per tier
// (SAL/LGA). The view is the centroid-only HDBSCAN/EVoC dendrogram from
// the `cluster_linkage` table, rendered by Cytoscape with dagre layout —
// mega-cluster at the top, leaves at the bottom, node + edge sizes
// proportional to the leaf count under each subtree.
//
// The legacy K-cut snapshot inspector (sankey + tabs + bar chart + member
// list) was removed in favour of the full linkage tree, per the analyst's
// "this is the only view I want" call.

import { useParams, useSearchParams } from "react-router-dom";

import { ClusterDendrogram } from "@/components/explorer/ClusterDendrogram";
import type { ClusterMethod, ClusterTier } from "@/lib/rental-sales-query";

export const DendrogramExplorer = () => {
	const { tier: tierParam } = useParams<{ tier: string }>();
	const tier: ClusterTier = tierParam === "lga" ? "lga" : "sal";
	const [searchParams, setSearchParams] = useSearchParams();

	const methodParam = searchParams.get("method");
	const method: ClusterMethod = methodParam === "evoc" ? "evoc" : "hdbscan";
	const setMethod = (next: ClusterMethod): void => {
		const params = new URLSearchParams(searchParams);
		params.set("method", next);
		setSearchParams(params, { replace: true });
	};

	const tierLabel = tier === "sal" ? "SAL" : "LGA";

	return (
		<div
			// h-full + overflow-y-auto so this column inherits the bounded
			// height from <main> (h-screen) and scrolls internally.
			className="h-full overflow-y-auto p-3"
			data-testid="dendrogram-explorer"
		>
			<header className="mb-3 flex flex-wrap items-baseline gap-3 border-neutral-200 border-b pb-3 dark:border-neutral-800">
				<h1 className="font-medium text-base text-neutral-900 dark:text-neutral-100">
					{tierLabel} cluster hierarchy
				</h1>
				<span className="text-neutral-500 text-sm dark:text-neutral-400">
					Centroid-only HDBSCAN/EVoC dendrogram — mega-cluster at top, polygons
					at the leaves.
				</span>
			</header>

			<section className="mb-4" data-testid="cluster-dendrogram-section">
				<ClusterDendrogram
					tier={tier}
					method={method}
					onMethodChange={setMethod}
				/>
			</section>
		</div>
	);
};
