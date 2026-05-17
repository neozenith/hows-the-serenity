// Unit tests for the school-zone tooltip formatter.

import { describe, expect, it } from "vitest";

import { schoolZoneTooltip } from "@/lib/school-zone-tooltip";

describe("schoolZoneTooltip", () => {
	it("returns 'layer name\\nschool (entity)' for a primary-zone feature", () => {
		expect(
			schoolZoneTooltip({
				level: "primary",
				School_Name: "Lockwood Primary School",
				ENTITY_CODE: 1074401,
				Year_Level: "P6",
			}),
		).toBe("Primary school zone\nLockwood Primary School (1074401)");
	});

	it("formats every catalogued secondary year level distinctly", () => {
		const got = schoolZoneTooltip({
			level: "secondary_year10",
			School_Name: "Some SC",
			ENTITY_CODE: "9999",
		});
		expect(got).toMatch(/^Secondary year 10 zone/);
	});

	it("prettifies an unknown level slug as a fallback rather than returning null", () => {
		const got = schoolZoneTooltip({
			level: "secondary_year13", // hypothetical future vendor key
			School_Name: "Future SC",
			ENTITY_CODE: 12345,
		});
		expect(got).toBe("Secondary Year13\nFuture SC (12345)");
	});

	it("returns null on a feature without either level or School_Name (not a school zone)", () => {
		expect(schoolZoneTooltip({ SAL_CODE21: "20002" })).toBeNull();
		expect(schoolZoneTooltip({})).toBeNull();
		expect(schoolZoneTooltip(null)).toBeNull();
	});

	it("emits the layer-name line even when only the level is present", () => {
		expect(schoolZoneTooltip({ level: "standalone_juniorsec" })).toBe(
			"Standalone junior-sec zone",
		);
	});
});
