// Pure-TS tests for SuburbPlot's trace-construction helpers.
//
// React component rendering tests are skipped here per the resolved G5 ADR
// (T5.4 unit-test seam): pure mapping functions live in `src/lib/` and are
// unit-tested directly; the live Plotly render is covered by Playwright e2e.

import { describe, expect, it } from "vitest";

import type { ForecastPoint, SuburbTimeSeries } from "./rental-sales-query";
import {
	buildForecastTrace,
	buildImputedBandTrace,
	recoverSigmaFromForecast,
} from "./suburb-plot-traces";

const SYNTHETIC_FORECAST: ReadonlyArray<ForecastPoint> = [
	{
		ts: new Date("2025-12-01"),
		yHat: 650,
		lo80: 630,
		hi80: 670,
		lo95: 615,
		hi95: 685,
		imputationMethod: "nowcast_sarima_cpi",
		isNowcast: true,
	},
	{
		ts: new Date("2026-03-01"),
		yHat: 655,
		lo80: 632,
		hi80: 678,
		lo95: 615,
		hi95: 695,
		imputationMethod: "nowcast_sarima_cpi",
		isNowcast: true,
	},
];

const SYNTHETIC_SERIES_WITH_FORECAST: SuburbTimeSeries = {
	dataType: "rental",
	dwellingType: "all",
	bedrooms: "all",
	imputed: false,
	points: [
		{ ts: new Date("2025-06-01"), value: 640 },
		{ ts: new Date("2025-09-01"), value: 645 },
	],
	forecast: SYNTHETIC_FORECAST,
};

const SYNTHETIC_SERIES_NO_FORECAST: SuburbTimeSeries = {
	dataType: "rental",
	dwellingType: "all",
	bedrooms: "all",
	imputed: false,
	points: [{ ts: new Date("2025-06-01"), value: 640 }],
};

describe("buildForecastTrace", () => {
	it("emits at least one dashed-line trace when forecast data is present", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST);
		expect(traces.length).toBeGreaterThan(0);
		const dashedLines = traces.filter(
			(t) => t.mode === "lines" && t.line?.dash === "longdash",
		);
		expect(dashedLines.length).toBeGreaterThan(0);
	});

	it("returns no traces when forecast data is absent", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_NO_FORECAST);
		expect(traces.length).toBe(0);
	});

	it("each emitted trace carries the forecast x/y arrays of equal length", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST);
		for (const trace of traces) {
			expect(trace.x.length).toBe(SYNTHETIC_FORECAST.length);
			expect(trace.y.length).toBe(SYNTHETIC_FORECAST.length);
			expect(trace.x.length).toBe(trace.y.length);
		}
	});

	it("emits two fill='tonexty' band traces by default (80% + 95%)", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST);
		const fillTraces = traces.filter((t) => t.fill === "tonexty");
		expect(fillTraces.length).toBe(2);
	});

	it("the two band fills span [lo95, hi95] and [lo80, hi80] respectively", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST);
		const fillTraces = traces.filter((t) => t.fill === "tonexty");
		// Sort by minimum y value — wider band (95%) has lower min than 80%.
		const sortedByMin = [...fillTraces].sort(
			(a, b) => Math.min(...a.y) - Math.min(...b.y),
		);
		const [outer, inner] = sortedByMin;
		expect(outer?.y).toEqual(SYNTHETIC_FORECAST.map((p) => p.lo95));
		expect(inner?.y).toEqual(SYNTHETIC_FORECAST.map((p) => p.lo80));
	});

	it("80% band fillcolor alpha is higher than 95% band's (darker inner)", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST);
		const fillTraces = traces.filter((t) => t.fill === "tonexty");
		const sortedByMin = [...fillTraces].sort(
			(a, b) => Math.min(...a.y) - Math.min(...b.y),
		);
		const [outer95, inner80] = sortedByMin;
		// fillcolor strings look like "rgba(r,g,b,a)" — parse the last value.
		const alphaOf = (rgba?: string): number => {
			if (!rgba) return NaN;
			const m = rgba.match(/rgba\([^)]*,\s*([\d.]+)\s*\)$/);
			return m ? Number(m[1]) : NaN;
		};
		const a95 = alphaOf(outer95?.fillcolor);
		const a80 = alphaOf(inner80?.fillcolor);
		expect(Number.isFinite(a95)).toBe(true);
		expect(Number.isFinite(a80)).toBe(true);
		expect(a80).toBeGreaterThan(a95);
	});

	it("intervals={[80]} emits exactly one band fill trace", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST, [80]);
		const fillTraces = traces.filter((t) => t.fill === "tonexty");
		expect(fillTraces.length).toBe(1);
		// The single fill must be the 80% band — y matches lo80.
		expect(fillTraces[0]?.y).toEqual(SYNTHETIC_FORECAST.map((p) => p.lo80));
	});

	it("intervals={[]} emits zero band fill traces (but keeps the dashed line)", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST, []);
		const fillTraces = traces.filter((t) => t.fill === "tonexty");
		expect(fillTraces.length).toBe(0);
		// Dashed point-forecast line always emits.
		const dashed = traces.filter(
			(t) => t.mode === "lines" && t.line?.dash === "longdash",
		);
		expect(dashed.length).toBe(1);
		expect(traces.length).toBe(1);
	});

	it("default intervals emit exactly two band fill traces", () => {
		const traces = buildForecastTrace(SYNTHETIC_SERIES_WITH_FORECAST);
		const fillTraces = traces.filter((t) => t.fill === "tonexty");
		expect(fillTraces.length).toBe(2);
	});
});

describe("recoverSigmaFromForecast", () => {
	it("inverts (hi95 - lo95) / (2·Z_95) from the smallest-horizon row", () => {
		const sigma = recoverSigmaFromForecast([
			{
				ts: new Date("2025-12-01"),
				yHat: 650,
				lo80: 638,
				hi80: 662,
				lo95: 631,
				hi95: 669,
				imputationMethod: "nowcast_sarima_cpi",
				isNowcast: true,
			},
		]);
		// width = 38 → σ = 38 / (2·1.9599…) ≈ 9.6939
		expect(sigma).not.toBeNull();
		expect((sigma as number) > 9.69 && (sigma as number) < 9.7).toBe(true);
	});

	it("returns null when the forecast is missing", () => {
		expect(recoverSigmaFromForecast(undefined)).toBeNull();
		expect(recoverSigmaFromForecast([])).toBeNull();
	});

	it("returns null when bounds are NULL (bedroom-borrowed forecast)", () => {
		const sigma = recoverSigmaFromForecast([
			{
				ts: new Date("2025-12-01"),
				yHat: 650,
				lo80: null,
				hi80: null,
				lo95: null,
				hi95: null,
				imputationMethod: "bedroom_borrowed",
				isNowcast: false,
			},
		]);
		expect(sigma).toBeNull();
	});

	it("returns null when the recovered σ is non-positive", () => {
		const sigma = recoverSigmaFromForecast([
			{
				ts: new Date("2025-12-01"),
				yHat: 650,
				lo80: 650,
				hi80: 650,
				lo95: 650,
				hi95: 650, // degenerate interval
				imputationMethod: "nowcast_sarima_cpi",
				isNowcast: true,
			},
		]);
		expect(sigma).toBeNull();
	});
});

describe("buildImputedBandTrace", () => {
	const IMPUTED_SERIES: SuburbTimeSeries = {
		dataType: "rental",
		dwellingType: "house",
		bedrooms: "all",
		imputed: true,
		points: [
			{ ts: new Date("2025-06-01"), value: 700 },
			{ ts: new Date("2025-09-01"), value: 710 },
		],
	};

	it("emits paired upper + lower fill traces when imputed with a valid σ", () => {
		const traces = buildImputedBandTrace(IMPUTED_SERIES, 10);
		expect(traces.length).toBe(2);
		expect(traces[0]?.fill).toBeUndefined();
		expect(traces[1]?.fill).toBe("tonexty");
		// upper > value > lower at every index
		const upper = traces[0]?.y as number[];
		const lower = traces[1]?.y as number[];
		expect(upper[0]).toBeGreaterThan(700);
		expect(lower[0]).toBeLessThan(700);
	});

	it("emits nothing when the series is not imputed", () => {
		const obs: SuburbTimeSeries = { ...IMPUTED_SERIES, imputed: false };
		expect(buildImputedBandTrace(obs, 10)).toEqual([]);
	});

	it("emits nothing when σ is null", () => {
		expect(buildImputedBandTrace(IMPUTED_SERIES, null)).toEqual([]);
	});

	it("emits nothing when the points array is empty", () => {
		const empty: SuburbTimeSeries = { ...IMPUTED_SERIES, points: [] };
		expect(buildImputedBandTrace(empty, 10)).toEqual([]);
	});
});
