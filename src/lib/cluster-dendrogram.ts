// Pure transforms backing the Cytoscape dendrogram on /explore/dendrogram.
// Takes the flat (node_id, parent_id, size, is_leaf) rows from the
// `cluster_linkage` DuckDB table and emits Cytoscape ElementDefinition[]
// suitable for the dagre layout. Pure so it's unit-testable without
// instantiating Cytoscape.

import type { ClusterLinkageNode } from "@/lib/rental-sales-query";

export type CytoNode = {
	group: "nodes";
	data: {
		id: string;
		label: string;
		size: number;
		isLeaf: boolean;
	};
};

export type CytoEdge = {
	group: "edges";
	data: {
		id: string;
		source: string;
		target: string;
		weight: number;
	};
};

export type CytoElement = CytoNode | CytoEdge;

// Linkage rows → Cytoscape elements. Conventions:
//
//   - One node per linkage row (every interior + every leaf).
//   - One edge from each non-root parent_id → node_id. Edge weight is
//     the child node's `size` (== leaf count under it), so dagre will
//     paint thicker edges where more polygons funnel through.
//   - Leaves get a leaf-flag the renderer uses to pick a marker style.
//
// Dagre's rank order is induced by the directed edge set, so always
// emit parent→child (mega-cluster → leaves). Tree-ness is asserted only
// in tests because the ETL guarantees a single root per (tier, method).
export const linkageRowsToCytoElements = (
	rows: ReadonlyArray<ClusterLinkageNode>,
): CytoElement[] => {
	const out: CytoElement[] = [];
	for (const r of rows) {
		out.push({
			group: "nodes",
			data: {
				id: r.nodeId,
				label: r.isLeaf ? r.nodeId : `n=${r.size}`,
				size: r.size,
				isLeaf: r.isLeaf,
			},
		});
	}
	for (const r of rows) {
		if (r.parentId === null) continue;
		out.push({
			group: "edges",
			data: {
				id: `${r.parentId}→${r.nodeId}`,
				source: r.parentId,
				target: r.nodeId,
				weight: r.size,
			},
		});
	}
	return out;
};

// Linear map of subtree size to a pixel radius. Bounded so a single
// 2-leaf cluster doesn't disappear and a 760-leaf root doesn't overflow
// the canvas. Used by the Cytoscape stylesheet to set `width`/`height`.
export const sizeToNodeRadius = (
	size: number,
	maxSize: number,
	{ min = 8, max = 48 }: { min?: number; max?: number } = {},
): number => {
	if (maxSize <= 0) return min;
	const t = Math.max(0, Math.min(1, size / maxSize));
	return min + (max - min) * t;
};

// Map size to an edge stroke width using the same bounded-linear shape.
export const sizeToEdgeWidth = (
	size: number,
	maxSize: number,
	{ min = 1, max = 12 }: { min?: number; max?: number } = {},
): number => sizeToNodeRadius(size, maxSize, { min, max });
