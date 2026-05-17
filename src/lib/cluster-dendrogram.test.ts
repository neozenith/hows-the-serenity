// Unit tests for the Cytoscape dendrogram pure helpers.

import { describe, expect, it } from "vitest";

import {
	linkageRowsToCytoElements,
	sizeToEdgeWidth,
	sizeToNodeRadius,
} from "@/lib/cluster-dendrogram";
import type { ClusterLinkageNode } from "@/lib/rental-sales-query";

// Tiny tree shaped like:
//          ROOT (size=4)
//         /            \
//      MID (size=2)    L4 (leaf size=1)
//      /     \
//    L1      L2
const tinyTree: ClusterLinkageNode[] = [
	{
		nodeId: "ROOT",
		parentId: null,
		size: 4,
		distance: 1.0,
		isLeaf: false,
	},
	{
		nodeId: "MID",
		parentId: "ROOT",
		size: 2,
		distance: 0.5,
		isLeaf: false,
	},
	{ nodeId: "L1", parentId: "MID", size: 1, distance: null, isLeaf: true },
	{ nodeId: "L2", parentId: "MID", size: 1, distance: null, isLeaf: true },
	{ nodeId: "L4", parentId: "ROOT", size: 1, distance: null, isLeaf: true },
];

describe("linkageRowsToCytoElements", () => {
	it("emits one node per row + one edge per non-root row", () => {
		const els = linkageRowsToCytoElements(tinyTree);
		const nodes = els.filter((e) => e.group === "nodes");
		const edges = els.filter((e) => e.group === "edges");
		expect(nodes.map((n) => n.data.id).sort()).toEqual([
			"L1",
			"L2",
			"L4",
			"MID",
			"ROOT",
		]);
		expect(edges.map((e) => e.data.id).sort()).toEqual([
			"MID→L1",
			"MID→L2",
			"ROOT→L4",
			"ROOT→MID",
		]);
	});

	it("orients every edge parent→child so dagre's rank pushes the mega-cluster to the top", () => {
		const els = linkageRowsToCytoElements(tinyTree);
		const edges = els.filter((e) => e.group === "edges");
		for (const e of edges) {
			// source must be the parent of target — i.e. there must exist a
			// linkage row whose nodeId == source AND whose subtree contains target.
			expect(["ROOT", "MID"]).toContain(e.data.source);
		}
		// All leaves are downstream of ROOT — no leaf is anyone's source.
		const sourceIds = new Set(edges.map((e) => e.data.source));
		for (const leaf of ["L1", "L2", "L4"])
			expect(sourceIds.has(leaf)).toBe(false);
	});

	it("propagates `size` into edge weight so dagre can render thicker edges where more polygons flow", () => {
		const els = linkageRowsToCytoElements(tinyTree);
		const edges = els.filter((e) => e.group === "edges");
		const byTarget = new Map(edges.map((e) => [e.data.id, e.data.weight]));
		expect(byTarget.get("ROOT→MID")).toBe(2); // MID has 2 leaves under it
		expect(byTarget.get("ROOT→L4")).toBe(1);
		expect(byTarget.get("MID→L1")).toBe(1);
	});

	it("flags leaf rows so the renderer can use a distinct marker style", () => {
		const els = linkageRowsToCytoElements(tinyTree);
		const leafFlags = new Map(
			els
				.filter((e) => e.group === "nodes")
				.map((n) => [n.data.id, n.data.isLeaf]),
		);
		expect(leafFlags.get("ROOT")).toBe(false);
		expect(leafFlags.get("MID")).toBe(false);
		expect(leafFlags.get("L1")).toBe(true);
	});
});

describe("sizeToNodeRadius + sizeToEdgeWidth", () => {
	it("returns the min when size is 0 or maxSize is 0", () => {
		expect(sizeToNodeRadius(0, 10)).toBe(8);
		expect(sizeToNodeRadius(5, 0)).toBe(8);
	});

	it("returns the max when size === maxSize", () => {
		expect(sizeToNodeRadius(10, 10)).toBe(48);
		expect(sizeToEdgeWidth(10, 10)).toBe(12);
	});

	it("interpolates linearly in between", () => {
		// midpoint of [8, 48] is 28
		expect(sizeToNodeRadius(5, 10)).toBe(28);
	});

	it("clamps oversize inputs to max so a runaway cluster doesn't blow out the canvas", () => {
		expect(sizeToNodeRadius(50, 10)).toBe(48);
	});
});
