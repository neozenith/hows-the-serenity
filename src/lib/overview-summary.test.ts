// Unit tests for the /explore/overview pure helpers.

import { describe, expect, it } from "vitest";

import {
	type CoverageInputRow,
	type RegionTotals,
	summariseCoverageRows,
} from "@/lib/overview-summary";

const totals: RegionTotals = {
	sal: { total: 2946, observed: 760 },
	lga: { total: 80, observed: 79 },
};

describe("summariseCoverageRows", () => {
	it("returns one entry per tier with totals + observed counts wired through", () => {
		const out = summariseCoverageRows([], totals);
		expect(out).toHaveLength(2);
		const sal = out.find((t) => t.tier === "sal");
		const lga = out.find((t) => t.tier === "lga");
		expect(sal).toMatchObject({ totalRegions: 2946, observedRegions: 760 });
		expect(lga).toMatchObject({ totalRegions: 80, observedRegions: 79 });
	});

	it("collapses observed/imputed/forecast rows for the same slice into one record", () => {
		const rows: CoverageInputRow[] = [
			{
				tier: "sal",
				dwellingType: "house",
				bedrooms: "3",
				sourceClass: "observed",
				regionCount: 138,
			},
			{
				tier: "sal",
				dwellingType: "house",
				bedrooms: "3",
				sourceClass: "imputed",
				regionCount: 622,
			},
			{
				tier: "sal",
				dwellingType: "house",
				bedrooms: "3",
				sourceClass: "forecast",
				regionCount: 760,
			},
		];
		const out = summariseCoverageRows(rows, totals);
		const sal = out.find((t) => t.tier === "sal");
		expect(sal?.slices).toEqual([
			{
				dwellingType: "house",
				bedrooms: "3",
				observed: 138,
				imputed: 622,
				forecast: 760,
			},
		]);
	});

	it("sorts slices deterministically by (dwellingType, bedrooms)", () => {
		const rows: CoverageInputRow[] = [
			{
				tier: "lga",
				dwellingType: "unit",
				bedrooms: "2",
				sourceClass: "observed",
				regionCount: 75,
			},
			{
				tier: "lga",
				dwellingType: "house",
				bedrooms: "3",
				sourceClass: "observed",
				regionCount: 79,
			},
			{
				tier: "lga",
				dwellingType: "house",
				bedrooms: "2",
				sourceClass: "observed",
				regionCount: 79,
			},
		];
		const out = summariseCoverageRows(rows, totals);
		const lga = out.find((t) => t.tier === "lga");
		expect(lga?.slices.map((s) => `${s.dwellingType}/${s.bedrooms}`)).toEqual([
			"house/2",
			"house/3",
			"unit/2",
		]);
	});

	it("ignores rows whose tier isn't sal or lga", () => {
		const rows = [
			{
				tier: "postcode" as unknown as "sal",
				dwellingType: "house",
				bedrooms: "2",
				sourceClass: "observed" as const,
				regionCount: 99,
			},
		];
		const out = summariseCoverageRows(rows, totals);
		expect(out.every((t) => t.slices.length === 0)).toBe(true);
	});
});
