// Unit tests for the pairwise set-diff classifier.

import { describe, expect, it } from "vitest";

import {
	classifyPairwiseDiffs,
	type PairKind,
	rollupByPattern,
	type SliceLineage,
} from "@/lib/cell-lineage";

const pairsOf = (s: SliceLineage): Record<PairKind, string> =>
	Object.fromEntries(s.diffs.map((d) => [d.pair, d.pattern])) as Record<
		PairKind,
		string
	>;

describe("classifyPairwiseDiffs", () => {
	it("tags pure vendor-gap slices P1 when observed is empty", () => {
		// LGA house all: obs=∅, imp=79, fc=79
		const codes79 = Array.from({ length: 79 }, (_, i) => `lga_${i}`);
		const lin = classifyPairwiseDiffs("house", "all", [], codes79, codes79);
		const pairs = pairsOf(lin);
		expect(pairs.imp_minus_obs).toBe("P1_VENDOR_GAP");
		expect(pairs.fc_minus_obs).toBe("P1_VENDOR_GAP");
	});

	it("tags large imp - obs as P4 cross-tier expansion", () => {
		// SAL all all: obs=203, imp=754, fc=754, imp - obs = 551
		const obs = Array.from({ length: 203 }, (_, i) => `sal_${i}`);
		const imp = Array.from({ length: 754 }, (_, i) => `sal_${i}`);
		const fc = imp;
		const lin = classifyPairwiseDiffs("all", "all", obs, imp, fc);
		const pairs = pairsOf(lin);
		expect(pairs.imp_minus_obs).toBe("P4_CROSS_TIER_IMPUTE_EXPANSION");
	});

	it("tags large obs - imp as P2 idempotent skip", () => {
		// SAL house all: obs=747, imp=201 (impute didn't re-run on
		// observed sales-house-all).
		const obs = Array.from({ length: 747 }, (_, i) => `sal_${i}`);
		const imp = obs.slice(0, 201);
		const lin = classifyPairwiseDiffs("house", "all", obs, imp, obs);
		const pairs = pairsOf(lin);
		expect(pairs.obs_minus_imp).toBe("P2_OBSERVED_NOT_REIMPUTED");
	});

	it("tags obs - fc as P3 below SARIMAX min-obs", () => {
		// LGA house 2: obs=79, fc=73, obs - fc = 6
		const obs = Array.from({ length: 79 }, (_, i) => `lga_${i}`);
		const fc = obs.slice(0, 73);
		const lin = classifyPairwiseDiffs("house", "2", obs, obs, fc);
		const pairs = pairsOf(lin);
		expect(pairs.obs_minus_fc).toBe("P3_BELOW_SARIMAX_MIN_OBS");
	});

	it("tags tiny diffs as P5 multi-SAL group edge case", () => {
		// 2-polygon symmetric difference, well under the noise threshold.
		const obs = ["a", "b", "c"];
		const imp = ["a", "b"];
		const lin = classifyPairwiseDiffs("house", "2", obs, imp, obs);
		const pairs = pairsOf(lin);
		expect(pairs.obs_minus_imp).toBe("P5_MULTI_SAL_GROUP_EDGE_CASE");
	});

	it("omits pairs where the diff is empty (fully reconciled)", () => {
		// Identical sets — no diff anywhere.
		const lin = classifyPairwiseDiffs("all", "all", ["a"], ["a"], ["a"]);
		expect(lin.diffs).toHaveLength(0);
	});

	it("dedupes polygons inside each diff and sorts the output", () => {
		const lin = classifyPairwiseDiffs("h", "2", ["c", "b", "a", "a"], [], []);
		const obsMinusImp = lin.diffs.find((d) => d.pair === "obs_minus_imp");
		expect(obsMinusImp?.polygons).toEqual(["a", "b", "c"]);
	});
});

describe("rollupByPattern", () => {
	it("groups slices by pattern, counting unique slices and polygons", () => {
		const slices: SliceLineage[] = [
			classifyPairwiseDiffs(
				"house",
				"all",
				[],
				["p1", "p2", "p3"],
				["p1", "p2", "p3"],
			),
			classifyPairwiseDiffs("unit", "all", [], ["p3", "p4"], ["p3", "p4"]),
		];
		const rollup = rollupByPattern(slices);
		const p1 = rollup.find((r) => r.pattern === "P1_VENDOR_GAP");
		expect(p1).toBeDefined();
		expect(p1?.slicesAffected).toBeGreaterThanOrEqual(2);
		// imp_minus_obs + fc_minus_obs both fire for each P1 slice → 2 examples × 2 slices = 4.
		expect(p1?.examples.length).toBeGreaterThan(0);
		// Unique polygons across both slices: p1, p2, p3, p4 (deduped).
		expect(p1?.uniquePolygons).toEqual(["p1", "p2", "p3", "p4"]);
	});

	it("orders patterns by loudness — most distinct slices first", () => {
		// P2 appears in 3 slices, P1 in 1.
		const slices: SliceLineage[] = [
			classifyPairwiseDiffs("house", "all", [], ["x"], ["x"]), // P1
			classifyPairwiseDiffs(
				"h",
				"2",
				Array(100)
					.fill(0)
					.map((_, i) => `a${i}`),
				[],
				[],
			),
			classifyPairwiseDiffs(
				"h",
				"3",
				Array(100)
					.fill(0)
					.map((_, i) => `b${i}`),
				[],
				[],
			),
			classifyPairwiseDiffs(
				"h",
				"4",
				Array(100)
					.fill(0)
					.map((_, i) => `c${i}`),
				[],
				[],
			),
		];
		const rollup = rollupByPattern(slices);
		// P2 (which gets emitted 3× from the obs-only slices) ranks above P1.
		const p2Index = rollup.findIndex(
			(r) => r.pattern === "P2_OBSERVED_NOT_REIMPUTED",
		);
		const p1Index = rollup.findIndex((r) => r.pattern === "P1_VENDOR_GAP");
		expect(p2Index).toBeGreaterThanOrEqual(0);
		expect(p1Index).toBeGreaterThanOrEqual(0);
		expect(p2Index).toBeLessThan(p1Index);
	});
});
