import { describe, expect, it } from "vitest";
import type { LayerVisibility } from "@/lib/layers";
import {
	formatLayers,
	formatView,
	parseLayers,
	parseView,
	writeParams,
} from "@/lib/map-url-state";

const DEFAULTS = {
	lga: true,
	suburbs: true,
	tileGrid: false,
} as unknown as LayerVisibility;

describe("view codec", () => {
	it("omits pitch and bearing when both are zero", () => {
		expect(
			formatView({
				latitude: -37.813612,
				longitude: 144.963118,
				zoom: 9,
				pitch: 0,
				bearing: 0,
			}),
		).toBe("-37.81361,144.96312,9.00");
	});

	it("round-trips a tilted, rotated camera", () => {
		const raw = formatView({
			latitude: -37.8,
			longitude: 145,
			zoom: 12.5,
			pitch: 60,
			bearing: -45,
		});
		expect(raw).toBe("-37.8,145,12.50,60,315");
		expect(parseView(raw)).toEqual({
			latitude: -37.8,
			longitude: 145,
			zoom: 12.5,
			pitch: 60,
			bearing: 315,
		});
	});

	it.each([
		null,
		"",
		"1,2",
		"1,2,3,4",
		"a,b,c",
		"-91,0,9",
		"0,181,9",
		"0,0,30",
	])("rejects malformed view %s", (raw) => {
		expect(parseView(raw)).toBeNull();
	});
});

describe("layers codec", () => {
	it("lists only active layers", () => {
		expect(formatLayers(DEFAULTS)).toBe("lga,suburbs");
	});

	it("treats absent param as no opinion", () => {
		expect(parseLayers(null, DEFAULTS)).toBeNull();
	});

	it("treats empty param as all off", () => {
		expect(parseLayers("", DEFAULTS)).toEqual({
			lga: false,
			suburbs: false,
			tileGrid: false,
		});
	});

	it("ignores unknown keys", () => {
		expect(parseLayers("tileGrid,gone", DEFAULTS)).toEqual({
			lga: false,
			suburbs: false,
			tileGrid: true,
		});
	});
});

describe("writeParams", () => {
	it("merges, deletes, and keeps other params and commas readable", () => {
		window.history.replaceState(null, "", "/?sources=rental&l=x");
		writeParams({ v: "1,2,3", l: null });
		expect(window.location.search).toBe("?sources=rental&v=1,2,3");
	});
});
