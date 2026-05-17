// HDBSCAN condensation + λ + stability — pure helpers backing the
// condensed-dendrogram view. Spec:
// docs/specs/hdbscan_condensed_dendrogram.md.
//
// Input: rows from the `cluster_linkage` DuckDB table (the raw scipy
// single-linkage binary tree HDBSCAN emits, persisted node-per-row).
// Output: a much smaller condensed tree where each remaining node is a
// real cluster (≥ min_cluster_size points) and every binary "shedding"
// merge has been collapsed into its parent.

import type { ClusterLinkageNode } from "@/lib/rental-sales-query";

export type CondensedTreeNode = {
	nodeId: string;
	parentId: string | null;
	sizeAtBirth: number;
	// λ = 1 / distance. lambdaBirth is the λ at which this cluster
	// appeared (i.e. its parent's death λ), or 0 for the root. lambdaDeath
	// is the λ at which it either splits (true split) OR loses its last
	// member through shedding. See docs/specs/hdbscan_condensed_dendrogram.md.
	lambdaBirth: number;
	lambdaDeath: number;
};

const lambdaOf = (distance: number | null | undefined): number =>
	distance && distance > 0 ? 1 / distance : 0;

export type CytoCondensedNode = {
	group: "nodes";
	data: {
		id: string;
		label: string;
		sizeAtBirth: number;
		lambdaBirth: number;
		lambdaDeath: number;
	};
};

export type CytoCondensedEdge = {
	group: "edges";
	data: {
		id: string;
		source: string;
		target: string;
		deltaLambda: number;
		minLen: number;
	};
};

export type CytoCondensedElement = CytoCondensedNode | CytoCondensedEdge;

// Map the condensed tree to Cytoscape elements. The contract is the
// "Visualisation contract" table in
// docs/specs/hdbscan_condensed_dendrogram.md — node width encodes
// size_at_birth, edge minLen encodes the λ-span (parent λ_death to
// child λ_birth which == parent λ_death by construction; but we drive
// minLen off the CHILD's persistence = lambdaDeath_child − lambdaBirth_child,
// because that's the "stable cluster = long bar" intuition HDBSCAN itself
// uses on its λ axis).
export const condensedTreeToCytoElements = (
	condensed: ReadonlyArray<CondensedTreeNode>,
	{
		lambdaPixelScale,
		maxMinLen = Number.POSITIVE_INFINITY,
	}: { lambdaPixelScale: number; maxMinLen?: number },
): CytoCondensedElement[] => {
	const nodes: CytoCondensedNode[] = condensed.map((c) => ({
		group: "nodes",
		data: {
			id: c.nodeId,
			label: `n=${c.sizeAtBirth}`,
			sizeAtBirth: c.sizeAtBirth,
			lambdaBirth: c.lambdaBirth,
			lambdaDeath: c.lambdaDeath,
		},
	}));
	const edges: CytoCondensedEdge[] = condensed
		.filter((c) => c.parentId !== null)
		.map((c) => {
			// The child's persistence (λ_death − λ_birth) is what HDBSCAN's
			// dendrogram shows as bar height — the more density-stable the
			// cluster, the taller it is. Drive the edge length off this.
			const deltaLambda = Math.max(0, c.lambdaDeath - c.lambdaBirth);
			// Clamp at maxMinLen so a runaway λ-span doesn't make dagre
			// allocate hundreds of dummy rank-nodes per edge and blow the
			// call stack. The visual contract holds (longer = more stable)
			// up to the cap; everything past it is "very stable" without
			// extra fidelity.
			const minLen = Math.min(
				maxMinLen,
				Math.max(1, Math.round(deltaLambda * lambdaPixelScale)),
			);
			return {
				group: "edges",
				data: {
					id: `${c.parentId}→${c.nodeId}`,
					source: c.parentId as string,
					target: c.nodeId,
					deltaLambda,
					minLen,
				},
			};
		});
	return [...nodes, ...edges];
};

type Adj = Map<string, ClusterLinkageNode[]>;

const buildChildIndex = (rows: ReadonlyArray<ClusterLinkageNode>): Adj => {
	const adj: Adj = new Map();
	const byId = new Map(rows.map((r) => [r.nodeId, r]));
	for (const r of rows) {
		if (r.parentId === null) continue;
		const list = adj.get(r.parentId) ?? [];
		list.push(r);
		adj.set(r.parentId, list);
	}
	// Stable ordering by nodeId so output is deterministic.
	for (const list of adj.values())
		list.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
	// Touching byId silences "unused" warnings without changing behaviour.
	void byId;
	return adj;
};

const findRoot = (
	rows: ReadonlyArray<ClusterLinkageNode>,
): ClusterLinkageNode | null => rows.find((r) => r.parentId === null) ?? null;

// Walk the binary tree, emitting a condensed-tree node every time a
// true split is observed (both children ≥ min_cluster_size). When only
// one side is ≥ min, the small side's points are treated as shedding
// events attached to the parent — they don't get their own cluster.
export const condenseLinkageTree = (
	rows: ReadonlyArray<ClusterLinkageNode>,
	minClusterSize: number,
): CondensedTreeNode[] => {
	const root = findRoot(rows);
	if (!root) return [];
	const adj = buildChildIndex(rows);
	const byId = new Map(rows.map((r) => [r.nodeId, r]));
	const out: CondensedTreeNode[] = [];

	const recurse = (
		clusterId: string,
		clusterSize: number,
		parentId: string | null,
		mergeNodeId: string,
		lambdaBirth: number,
	): void => {
		// We don't know lambdaDeath yet — fill in once we hit a split or
		// the cluster fully dissolves.
		const record: CondensedTreeNode = {
			nodeId: clusterId,
			parentId,
			sizeAtBirth: clusterSize,
			lambdaBirth,
			lambdaDeath: lambdaBirth, // tentative; overwritten below
		};
		out.push(record);

		let cursor = mergeNodeId;
		while (true) {
			const children = adj.get(cursor) ?? [];
			const interior = children.filter((c) => !c.isLeaf);
			const leafKids = children.filter((c) => c.isLeaf);
			const cursorRow = byId.get(cursor);
			const cursorLambda = lambdaOf(cursorRow?.distance);
			if (interior.length === 0) {
				// Cluster dies when its last leaf children shed; if there
				// are leaf kids on this cursor merge, that's the death.
				record.lambdaDeath = leafKids.length > 0 ? cursorLambda : lambdaBirth;
				return;
			}
			if (interior.length === 1) {
				const sole = interior[0];
				if (!sole) return;
				cursor = sole.nodeId;
				continue;
			}
			const ranked = [...interior].sort((a, b) => b.size - a.size);
			const big = ranked[0];
			const small = ranked[1];
			if (!big || !small) return;
			const bothBigEnough =
				big.size >= minClusterSize && small.size >= minClusterSize;
			if (bothBigEnough) {
				// True split — this cluster dies at the cursor merge's λ
				// and the two children are born at that same λ.
				record.lambdaDeath = cursorLambda;
				for (const child of ranked) {
					recurse(
						child.nodeId,
						child.size,
						clusterId,
						child.nodeId,
						cursorLambda,
					);
				}
				return;
			}
			cursor = big.nodeId;
		}
	};

	// Root's λ_birth = 0 (no parent merge that birthed it).
	recurse(root.nodeId, root.size, null, root.nodeId, 0);
	return out;
};
