// Unit tests for the polygon-hover-label pure helper.

import { describe, expect, it } from "vitest";

import { polygonHoverLabel } from "@/lib/polygon-tooltip";

describe("polygonHoverLabel", () => {
	it("returns 'CODE — Name' for a SAL feature with SAL_CODE21 + SAL_NAME21", () => {
		const label = polygonHoverLabel("sal", {
			SAL_CODE21: "20002",
			SAL_NAME21: "Abbotsford (Vic.)",
		});
		expect(label).toBe("20002 — Abbotsford (Vic.)");
	});

	it("returns 'CODE — Name' for an LGA feature with LGA_CODE24 + LGA_NAME24", () => {
		const label = polygonHoverLabel("lga", {
			LGA_CODE24: "24600",
			LGA_NAME24: "Melbourne",
		});
		expect(label).toBe("24600 — Melbourne");
	});

	it("returns null when the tier-specific name property is missing", () => {
		// The property set is from the OTHER tier — no SAL name to show.
		expect(
			polygonHoverLabel("sal", { LGA_CODE24: "24600", LGA_NAME24: "Melb" }),
		).toBeNull();
	});

	it("returns the code alone when the name property is missing but code is present", () => {
		// Defensive: a feature without a name still gets a useful tooltip.
		expect(polygonHoverLabel("sal", { SAL_CODE21: "20002" })).toBe("20002");
	});

	it("returns null on a feature with neither code nor name", () => {
		expect(polygonHoverLabel("lga", {})).toBeNull();
		expect(polygonHoverLabel("lga", null)).toBeNull();
	});
});
