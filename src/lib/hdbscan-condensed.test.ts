// Unit tests for the HDBSCAN condensation + λ + stability pure helpers.
// Spec: docs/specs/hdbscan_condensed_dendrogram.md.

import { describe, expect, it } from "vitest";

import {
	condensedTreeToCytoElements,
	condenseLinkageTree,
} from "@/lib/hdbscan-condensed";
import type { ClusterLinkageNode } from "@/lib/rental-sales-query";

// Pure-leaf rows have parent_id set to whoever they merged into.
// Pure-interior rows have non-null distance + the same.
// This is the shape `cluster_linkage` ships in.

const leaf = (id: string, parent: string | null): ClusterLinkageNode => ({
	nodeId: id,
	parentId: parent,
	size: 1,
	distance: null,
	isLeaf: true,
});

const interior = (
	id: string,
	parent: string | null,
	size: number,
	distance: number,
): ClusterLinkageNode => ({
	nodeId: id,
	parentId: parent,
	size,
	distance,
	isLeaf: false,
});

describe("condensedTreeToCytoElements", () => {
	it("emits one node per cluster + one edge per parent→child with minLen proportional to Δλ", () => {
		// Hand-built condensed tree (skips the condenseLinkageTree step so
		// the test stays focused on the cyto translation):
		// ROOT  λ_birth=0    λ_death=1/4
		// LEFT  λ_birth=1/4  λ_death=1/1   → Δλ = 1 - 0.25 = 0.75
		// RIGHT λ_birth=1/4  λ_death=1/2   → Δλ = 0.5 - 0.25 = 0.25
		const condensed = [
			{
				nodeId: "ROOT",
				parentId: null,
				sizeAtBirth: 6,
				lambdaBirth: 0,
				lambdaDeath: 0.25,
			},
			{
				nodeId: "LEFT",
				parentId: "ROOT",
				sizeAtBirth: 4,
				lambdaBirth: 0.25,
				lambdaDeath: 1,
			},
			{
				nodeId: "RIGHT",
				parentId: "ROOT",
				sizeAtBirth: 2,
				lambdaBirth: 0.25,
				lambdaDeath: 0.5,
			},
		];
		const els = condensedTreeToCytoElements(condensed, {
			lambdaPixelScale: 40,
		});
		const nodes = els.filter((e) => e.group === "nodes");
		const edges = els.filter((e) => e.group === "edges");
		expect(nodes.map((n) => n.data.id).sort()).toEqual([
			"LEFT",
			"RIGHT",
			"ROOT",
		]);
		expect(edges.map((e) => e.data.id).sort()).toEqual([
			"ROOT→LEFT",
			"ROOT→RIGHT",
		]);
		// LEFT's outgoing edge (parent ROOT → child LEFT) has Δλ = 0.75
		// → minLen = round(0.75 * 40) = 30. RIGHT's Δλ = 0.25 → minLen = 10.
		const byId = new Map(edges.map((e) => [e.data.id, e.data]));
		expect(byId.get("ROOT→LEFT")?.minLen).toBe(30);
		expect(byId.get("ROOT→RIGHT")?.minLen).toBe(10);
	});

	it("clamps minLen to a configurable maxMinLen so dagre doesn't blow its stack on long λ-spans", () => {
		// Real LGA data has Δλ up to ~11.8; at lambdaPixelScale=40 the
		// raw minLen would be 473, which makes dagre's successors()
		// traversal recursively allocate 473 dummy nodes per edge and
		// overflow the JS call stack. maxMinLen caps the rank span so
		// extreme edges still rank correctly but stop short of breaking
		// the layout.
		const condensed = [
			{
				nodeId: "ROOT",
				parentId: null,
				sizeAtBirth: 4,
				lambdaBirth: 0,
				lambdaDeath: 0,
			},
			{
				nodeId: "TALL",
				parentId: "ROOT",
				sizeAtBirth: 2,
				lambdaBirth: 0,
				lambdaDeath: 20,
			},
		];
		const els = condensedTreeToCytoElements(condensed, {
			lambdaPixelScale: 40,
			maxMinLen: 30,
		});
		const edge = els.find((e) => e.group === "edges");
		expect(edge?.data.minLen).toBe(30); // clamped down from 20*40=800
	});

	it("clamps minLen to at least 1 so dagre always honours the rank ordering", () => {
		const condensed = [
			{
				nodeId: "ROOT",
				parentId: null,
				sizeAtBirth: 4,
				lambdaBirth: 0,
				lambdaDeath: 0,
			},
			{
				// Same λ as parent (degenerate, zero Δλ) — still needs minLen ≥ 1.
				nodeId: "FLAT",
				parentId: "ROOT",
				sizeAtBirth: 2,
				lambdaBirth: 0,
				lambdaDeath: 0,
			},
		];
		const els = condensedTreeToCytoElements(condensed, {
			lambdaPixelScale: 40,
		});
		const edge = els.find((e) => e.group === "edges");
		expect(edge?.data.minLen).toBe(1);
	});
});

describe("condenseLinkageTree", () => {
	it("collapses a merge where one side is < min_cluster_size into the parent cluster", () => {
		// Tree:
		//   ROOT (C3, size=5, d=4)
		//     ├── C2 (size=4, d=2)
		//     │     ├── C0 (size=2, d=1) — A, B
		//     │     └── single_leaf E   <- sheds at d=2, doesn't survive
		//     └── single_leaf F          <- sheds at d=4
		//
		// With min_cluster_size=2:
		//   - ROOT split (C2 size=4, F size=1): F sheds; C2 inherits ROOT.
		//   - At d=2 merge (C0 size=2, E size=1): E sheds; C0 inherits.
		//   - At d=1 merge: leaves A, B both shed; cluster dies.
		// Net: only 1 cluster node survives (the trunk = root id).
		const rows: ClusterLinkageNode[] = [
			interior("C3", null, 5, 4.0),
			interior("C2", "C3", 4, 2.0),
			interior("C0", "C2", 2, 1.0),
			leaf("A", "C0"),
			leaf("B", "C0"),
			leaf("E", "C2"),
			leaf("F", "C3"),
		];
		const condensed = condenseLinkageTree(rows, 2);
		// The whole tree condenses to a single trunk-cluster (the root).
		expect(condensed).toHaveLength(1);
		expect(condensed[0]?.nodeId).toBe("C3");
		expect(condensed[0]?.parentId).toBeNull();
	});

	it("populates lambdaBirth + lambdaDeath per cluster (λ = 1/distance)", () => {
		// Same 4-leaf balanced tree as before but now check λ values.
		// ROOT (d=3) → λ_birth(ROOT)=0 (no parent), λ_death(ROOT)=1/3
		// C0   (d=1) → λ_birth(C0)=1/3 (parent merged at d=3), λ_death(C0)=1/1 (then A+B shed)
		// C1   (d=1.5) → λ_birth=1/3, λ_death=1/1.5
		const rows: ClusterLinkageNode[] = [
			interior("C2", null, 4, 3.0),
			interior("C0", "C2", 2, 1.0),
			interior("C1", "C2", 2, 1.5),
			leaf("A", "C0"),
			leaf("B", "C0"),
			leaf("C", "C1"),
			leaf("D", "C1"),
		];
		const condensed = condenseLinkageTree(rows, 2);
		const byId = new Map(condensed.map((c) => [c.nodeId, c]));
		expect(byId.get("C2")?.lambdaBirth).toBe(0);
		expect(byId.get("C2")?.lambdaDeath).toBeCloseTo(1 / 3, 6);
		expect(byId.get("C0")?.lambdaBirth).toBeCloseTo(1 / 3, 6);
		expect(byId.get("C0")?.lambdaDeath).toBeCloseTo(1 / 1.0, 6);
		expect(byId.get("C1")?.lambdaBirth).toBeCloseTo(1 / 3, 6);
		expect(byId.get("C1")?.lambdaDeath).toBeCloseTo(1 / 1.5, 6);
	});

	it("returns one condensed-tree node per cluster (NOT per merge) for a perfectly-balanced tree", () => {
		// A 4-leaf binary tree where every merge is a true split (both
		// sides have size 2 ≥ min_cluster_size). After condensation we
		// expect exactly 3 cluster nodes: ROOT + the two size-2 children.
		// Leaves never appear as cluster nodes in the condensed tree.
		const rows: ClusterLinkageNode[] = [
			interior("C2", null, 4, 3.0),
			interior("C0", "C2", 2, 1.0),
			interior("C1", "C2", 2, 1.5),
			leaf("A", "C0"),
			leaf("B", "C0"),
			leaf("C", "C1"),
			leaf("D", "C1"),
		];
		const condensed = condenseLinkageTree(rows, 2);
		const ids = condensed.map((c) => c.nodeId).sort();
		expect(ids).toEqual(["C0", "C1", "C2"]);
		// Root's parent is null; the other two parent under the root.
		const byId = new Map(condensed.map((c) => [c.nodeId, c]));
		expect(byId.get("C2")?.parentId).toBeNull();
		expect(byId.get("C0")?.parentId).toBe("C2");
		expect(byId.get("C1")?.parentId).toBe("C2");
	});
});
