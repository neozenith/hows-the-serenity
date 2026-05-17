// Unit tests for the cell→polygon flattening helper.

import { describe, expect, it } from "vitest";

import { flattenCellCodes } from "@/lib/cell-polygons";

describe("flattenCellCodes", () => {
	it("returns single-code keys unchanged", () => {
		expect(flattenCellCodes(["20001", "20002", "20003"])).toEqual([
			"20001",
			"20002",
			"20003",
		]);
	});

	it("splits vendor multi-SAL group strings on `-`", () => {
		// The two SALs in `20018-21677` are both attributable to the metric.
		expect(flattenCellCodes(["20018-21677"])).toEqual(["20018", "21677"]);
	});

	it("flattens a mix of singletons and groups and dedupes overlaps", () => {
		const out = flattenCellCodes([
			"20001",
			"20002-20001", // 20001 already present — must dedupe
			"20003-20004-20005",
		]);
		expect(out).toEqual(["20001", "20002", "20003", "20004", "20005"]);
	});

	it("sorts the output deterministically", () => {
		const out = flattenCellCodes(["99999", "10000-50000"]);
		expect(out).toEqual(["10000", "50000", "99999"]);
	});

	it("ignores empty strings and trims whitespace inside group strings", () => {
		const out = flattenCellCodes(["", " 20001 ", "20002 -  20003 "]);
		expect(out).toEqual(["20001", "20002", "20003"]);
	});
});
