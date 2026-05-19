// Pure-TS tests for the /explore source-filter helpers. Mirrors the
// existing src/lib/*.test.ts convention — DuckDB and React not in scope.

import { describe, expect, it } from "vitest";

import type { ForecastPoint, SuburbTimeSeries } from "./rental-sales-query";
import {
	DEFAULT_SOURCE_FILTER,
	filterSeries,
	filterYieldPoints,
	filterYieldSeries,
	parseSourceFilter,
	SOURCE_FILTER_LABELS,
	SOURCE_FILTERS,
	type SourceFilter,
	shouldShowForecast,
	shouldShowImputedBand,
	shouldShowImputedSeries,
} from "./source-filter";
import type { YieldPoint, YieldSeries } from "./yield-ratio";

const FC: ReadonlyArray<ForecastPoint> = [
	{
		ts: new Date("2025-12-01"),
		yHat: 700,
		lo80: 680,
		hi80: 720,
		lo95: 660,
		hi95: 740,
		imputationMethod: "nowcast_sarima_cpi",
		isNowcast: true,
	},
];

const observedSeries: SuburbTimeSeries = {
	dataType: "rental",
	dwellingType: "house",
	bedrooms: "3",
	imputed: false,
	points: [{ ts: new Date("2024-06-01"), value: 600 }],
	forecast: FC,
};

const imputedSeries: SuburbTimeSeries = {
	dataType: "rental",
	dwellingType: "unit",
	bedrooms: "2",
	imputed: true,
	points: [{ ts: new Date("2024-06-01"), value: 480 }],
	forecast: FC,
};

const observedNoForecast: SuburbTimeSeries = {
	dataType: "sales",
	dwellingType: "house",
	bedrooms: "all",
	imputed: false,
	points: [{ ts: new Date("2024-06-01"), value: 950_000 }],
	// no forecast field — must not be re-created by the filter.
};

describe("parseSourceFilter", () => {
	it("returns the default when input is null/undefined/garbage", () => {
		expect(parseSourceFilter(null)).toBe(DEFAULT_SOURCE_FILTER);
		expect(parseSourceFilter(undefined)).toBe(DEFAULT_SOURCE_FILTER);
		expect(parseSourceFilter("nonsense")).toBe(DEFAULT_SOURCE_FILTER);
	});

	it("is case-insensitive across the known set", () => {
		expect(parseSourceFilter("ALL")).toBe("all");
		expect(parseSourceFilter("Observed")).toBe("observed");
		expect(parseSourceFilter("imputed")).toBe("imputed");
		expect(parseSourceFilter("FORECAST")).toBe("forecast");
	});
});

describe("filter-mode predicates", () => {
	const cases: ReadonlyArray<[SourceFilter, boolean, boolean]> = [
		// [mode, includeImputed, includeForecast]
		["all", true, true],
		["observed", false, false],
		["imputed", true, false],
		["forecast", false, true],
	];
	it.each(cases)("%s → imputed=%s, forecast=%s", (mode, imputed, forecast) => {
		expect(shouldShowImputedSeries(mode)).toBe(imputed);
		expect(shouldShowForecast(mode)).toBe(forecast);
		expect(shouldShowImputedBand(mode)).toBe(imputed);
	});
});

describe("filterSeries", () => {
	const all = [observedSeries, imputedSeries, observedNoForecast];

	it("all: returns everything with forecasts intact", () => {
		const out = filterSeries(all, "all");
		expect(out).toHaveLength(3);
		expect(out[0]?.forecast).toBe(FC);
	});

	it("observed: drops imputed series and strips forecast off survivors", () => {
		const out = filterSeries(all, "observed");
		expect(out.map((s) => s.dwellingType)).toEqual(["house", "house"]);
		// Forecast must be stripped because forecast traces are forbidden in
		// observed-only mode.
		for (const s of out) expect(s.forecast).toBeUndefined();
	});

	it("imputed: keeps imputed series + observed, strips forecasts", () => {
		const out = filterSeries(all, "imputed");
		expect(out).toHaveLength(3);
		for (const s of out) expect(s.forecast).toBeUndefined();
	});

	it("forecast: drops imputed series, keeps observed + their forecasts", () => {
		const out = filterSeries(all, "forecast");
		expect(out.map((s) => s.imputed)).toEqual([false, false]);
		// The forecast-bearing observed series keeps its forecast …
		expect(out[0]?.forecast).toBe(FC);
		// … but the observed-no-forecast series is untouched (same reference,
		// so plotly's deep-compare bails on re-render).
		expect(out[1]).toBe(observedNoForecast);
	});
});

describe("filterYieldPoints / filterYieldSeries", () => {
	const points: ReadonlyArray<YieldPoint> = [
		{ ts: new Date("2024-06-01"), value: 0.04, qualifier: "observed" },
		{
			ts: new Date("2024-12-01"),
			value: 0.041,
			qualifier: "partially_imputed",
		},
		{ ts: new Date("2025-06-01"), value: 0.042, qualifier: "fully_imputed" },
		{ ts: new Date("2025-12-01"), value: 0.045, qualifier: "forecast" },
	];

	const series: YieldSeries = {
		dwellingType: "house",
		bedrooms: "3",
		qualifier: "observed",
		points: [...points],
	};

	it("all → keeps everything", () => {
		expect(filterYieldPoints(points, "all")).toHaveLength(4);
		expect(filterYieldSeries([series], "all")[0]?.points).toHaveLength(4);
	});

	it("observed → only the observed point", () => {
		const out = filterYieldPoints(points, "observed");
		expect(out.map((p) => p.qualifier)).toEqual(["observed"]);
	});

	it("imputed → observed + partially + fully (no forecast)", () => {
		const out = filterYieldPoints(points, "imputed");
		expect(out.map((p) => p.qualifier)).toEqual([
			"observed",
			"partially_imputed",
			"fully_imputed",
		]);
	});

	it("forecast → observed + forecast (no imputed)", () => {
		const out = filterYieldPoints(points, "forecast");
		expect(out.map((p) => p.qualifier)).toEqual(["observed", "forecast"]);
	});

	it("empty result drops the series entirely", () => {
		const allForecast: YieldSeries = {
			...series,
			points: points.filter((p) => p.qualifier === "forecast"),
		};
		expect(filterYieldSeries([allForecast], "observed")).toEqual([]);
	});
});

describe("SOURCE_FILTERS catalogue contract", () => {
	it("has exactly the four documented modes with non-empty labels", () => {
		expect(SOURCE_FILTERS).toEqual(["all", "observed", "imputed", "forecast"]);
		for (const f of SOURCE_FILTERS) {
			expect(SOURCE_FILTER_LABELS[f].length).toBeGreaterThan(0);
		}
	});
});
