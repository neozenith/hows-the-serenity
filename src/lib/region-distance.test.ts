// Pure-TS tests for the /explore RegionPicker geographic-sort helpers.

import { describe, expect, it } from "vitest";

import {
	type CentroidMap,
	DEFAULT_SORT_MODE,
	formatDistanceKm,
	haversineKm,
	MELBOURNE_LGA_CODE,
	MELBOURNE_SAL_CODE,
	parseSortMode,
	rankByDistance,
	rankByName,
	referenceCodeFor,
	sortOptions,
} from "./region-distance";

// Real Melbourne SAL centroid coords (from public/data/suburb_centroids.json).
const MELBOURNE_SAL: readonly [number, number] = [144.97993, -37.82658];
// Abbotsford SAL — adjacent suburb, ~2km north-east of CBD.
const ABBOTSFORD_SAL: readonly [number, number] = [145.00001, -37.80378];
// Mildura SAL — far north-west Victoria, several hundred km from CBD.
const MILDURA_SAL: readonly [number, number] = [142.18, -34.18];

describe("haversineKm", () => {
	it("returns 0 for the same point", () => {
		expect(haversineKm(MELBOURNE_SAL, MELBOURNE_SAL)).toBe(0);
	});

	it("approximates ~2-3 km for adjacent inner Melbourne suburbs", () => {
		const d = haversineKm(MELBOURNE_SAL, ABBOTSFORD_SAL);
		expect(d).toBeGreaterThan(2);
		expect(d).toBeLessThan(4);
	});

	it("approximates ~500 km for Mildura ↔ Melbourne", () => {
		const d = haversineKm(MELBOURNE_SAL, MILDURA_SAL);
		expect(d).toBeGreaterThan(400);
		expect(d).toBeLessThan(600);
	});

	it("is symmetric", () => {
		const a = haversineKm(MELBOURNE_SAL, MILDURA_SAL);
		const b = haversineKm(MILDURA_SAL, MELBOURNE_SAL);
		expect(a).toBeCloseTo(b, 6);
	});
});

describe("parseSortMode", () => {
	it("defaults when input is null/undefined/garbage", () => {
		expect(parseSortMode(null)).toBe(DEFAULT_SORT_MODE);
		expect(parseSortMode(undefined)).toBe(DEFAULT_SORT_MODE);
		expect(parseSortMode("xx")).toBe(DEFAULT_SORT_MODE);
	});
	it("accepts known values case-insensitively", () => {
		expect(parseSortMode("alpha")).toBe("alpha");
		expect(parseSortMode("GEO")).toBe("geo");
	});
});

describe("referenceCodeFor", () => {
	it("returns the Melbourne SAL/LGA codes per kind", () => {
		expect(referenceCodeFor("suburb")).toBe(MELBOURNE_SAL_CODE);
		expect(referenceCodeFor("lga")).toBe(MELBOURNE_LGA_CODE);
	});
});

describe("rankByDistance", () => {
	const centroids: CentroidMap = {
		[MELBOURNE_SAL_CODE]: MELBOURNE_SAL,
		"20002": ABBOTSFORD_SAL,
		"24780": MILDURA_SAL,
	};

	it("puts the reference region first with distanceKm=0, then ascending", () => {
		const ranked = rankByDistance(
			[
				{ code: "24780", name: "Mildura" },
				{ code: "20002", name: "Abbotsford" },
				{ code: MELBOURNE_SAL_CODE, name: "Melbourne" },
			],
			centroids,
			MELBOURNE_SAL_CODE,
		);
		expect(ranked.map((r) => r.code)).toEqual([
			MELBOURNE_SAL_CODE,
			"20002",
			"24780",
		]);
		expect(ranked[0]?.distanceKm).toBe(0);
		expect(ranked[0]?.isReference).toBe(true);
		expect(ranked[1]?.distanceKm).toBeLessThan(ranked[2]?.distanceKm ?? 0);
	});

	it("pushes options with no centroid to the end (Infinity), alpha among tail", () => {
		const ranked = rankByDistance(
			[
				{ code: "unknown_b", name: "Zebra" },
				{ code: "unknown_a", name: "Aardvark" },
				{ code: MELBOURNE_SAL_CODE, name: "Melbourne" },
			],
			centroids,
			MELBOURNE_SAL_CODE,
		);
		expect(ranked[0]?.code).toBe(MELBOURNE_SAL_CODE);
		// Tail is sorted by name among Infinity-distance entries.
		expect(ranked.slice(1).map((r) => r.code)).toEqual([
			"unknown_a",
			"unknown_b",
		]);
	});

	it("returns alphabetical when no reference centroid is available", () => {
		const ranked = rankByDistance(
			[
				{ code: "20002", name: "Abbotsford" },
				{ code: MELBOURNE_SAL_CODE, name: "Melbourne" },
			],
			{
				/* no entry for reference */
			} as CentroidMap,
			MELBOURNE_SAL_CODE,
		);
		expect(ranked.map((r) => r.code)).toEqual(["20002", MELBOURNE_SAL_CODE]);
	});
});

describe("rankByName", () => {
	it("sorts alphabetically and stamps Infinity/isReference=false", () => {
		const ranked = rankByName([
			{ code: "z", name: "Zebra" },
			{ code: "a", name: "Aardvark" },
		]);
		expect(ranked.map((r) => r.name)).toEqual(["Aardvark", "Zebra"]);
		expect(ranked[0]?.distanceKm).toBe(Number.POSITIVE_INFINITY);
		expect(ranked[0]?.isReference).toBe(false);
	});
});

describe("sortOptions dispatch", () => {
	const opts = [
		{ code: "24780", name: "Mildura" },
		{ code: "20002", name: "Abbotsford" },
		{ code: MELBOURNE_SAL_CODE, name: "Melbourne" },
	];
	const centroids: CentroidMap = {
		[MELBOURNE_SAL_CODE]: MELBOURNE_SAL,
		"20002": ABBOTSFORD_SAL,
		"24780": MILDURA_SAL,
	};
	it("alpha: ignores centroids and sorts by name", () => {
		const ranked = sortOptions(opts, "alpha", centroids, MELBOURNE_SAL_CODE);
		expect(ranked.map((r) => r.name)).toEqual([
			"Abbotsford",
			"Melbourne",
			"Mildura",
		]);
	});
	it("geo with null centroids: falls back to alpha", () => {
		const ranked = sortOptions(opts, "geo", null, MELBOURNE_SAL_CODE);
		expect(ranked.map((r) => r.name)).toEqual([
			"Abbotsford",
			"Melbourne",
			"Mildura",
		]);
	});
	it("geo with centroids: reference first, then by distance", () => {
		const ranked = sortOptions(opts, "geo", centroids, MELBOURNE_SAL_CODE);
		expect(ranked[0]?.code).toBe(MELBOURNE_SAL_CODE);
		expect(ranked.at(-1)?.code).toBe("24780");
	});
});

describe("formatDistanceKm", () => {
	it("renders the reference at exactly '0 km'", () => {
		expect(formatDistanceKm(0)).toBe("0 km");
	});
	it("renders <10 km with one decimal", () => {
		expect(formatDistanceKm(2.345)).toBe("2.3 km");
	});
	it("rounds ≥10 km to whole km", () => {
		expect(formatDistanceKm(123.4)).toBe("123 km");
	});
	it("returns empty for non-finite distances", () => {
		expect(formatDistanceKm(Number.POSITIVE_INFINITY)).toBe("");
	});
});
