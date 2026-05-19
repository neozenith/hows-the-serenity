// Source-data filter for the /explore page. The RegionDualPlot's top
// toolbar lets the analyst restrict the rental/sales/yield charts to
// any subset of {observed, imputed, forecast} in four named modes:
//
//   "all"      — observed + imputed + forecast (default; matches the
//                pre-toggle behaviour of every chart on the page)
//   "observed" — only vendor-observed historicals; no imputed series,
//                no forecast continuations, no imputed σ bands.
//   "imputed"  — observed + imputed historicals together; forecasts and
//                their interval bands are hidden.
//   "forecast" — observed historicals + forecast continuations; imputed
//                series and imputed σ bands are hidden.
//
// Note that "imputed" and "forecast" *both* include observed — the
// labels match the on-screen toggle ("Observed + Imputed", "Observed +
// Forecast"). There is no observed-less mode; observed is always in.
//
// All helpers are pure so they can be unit-tested without React or
// Plotly (see `source-filter.test.ts`). The filter is serialised into
// the `?sources=` URL parameter by the toolbar so a pasted /explore
// link reproduces the analyst's view exactly.

import type { ForecastPoint, SuburbTimeSeries } from "./rental-sales-query";
import type { YieldPoint, YieldSeries } from "./yield-ratio";

export type SourceFilter = "all" | "observed" | "imputed" | "forecast";

export const DEFAULT_SOURCE_FILTER: SourceFilter = "all";

export const SOURCE_FILTERS: ReadonlyArray<SourceFilter> = [
	"all",
	"observed",
	"imputed",
	"forecast",
] as const;

// URL ↔ enum helpers. Unknown / missing values collapse to the default
// rather than throwing — a typed-in URL with `?sources=garbage` should
// render the default chart, not blow up.
export const SOURCE_FILTER_PARAM = "sources";

export const parseSourceFilter = (
	raw: string | null | undefined,
): SourceFilter => {
	if (raw == null) return DEFAULT_SOURCE_FILTER;
	const lower = raw.toLowerCase();
	return (SOURCE_FILTERS as ReadonlyArray<string>).includes(lower)
		? (lower as SourceFilter)
		: DEFAULT_SOURCE_FILTER;
};

// Human-readable label for the toggle UI. Kept here (not in the
// component) so the labels are part of the testable shape — a renamed
// option is a visible diff in the unit-test file, not just a JSX edit.
export const SOURCE_FILTER_LABELS: Readonly<Record<SourceFilter, string>> = {
	all: "All",
	observed: "Observed",
	imputed: "Observed + Imputed",
	forecast: "Observed + Forecast",
};

// ---------------------------------------------------------------------------
// Per-trace-class predicates
// ---------------------------------------------------------------------------
//
// SuburbTimeSeries carries a series-level `imputed` flag (the whole
// slice is observed XOR imputed) and an optional `forecast` array. The
// four modes resolve to three independent yes/no decisions per series:
//
//                       includeImputedSeries  includeForecast  includeImputedBand
//   all                 true                  true             true
//   observed            false                 false            false
//   imputed             true                  false            false
//   forecast            false                 true             false
//
// `includeImputedBand` mirrors `includeImputedSeries` (the band is the
// uncertainty wrapper on an imputed line — if the line is hidden, the
// band has nothing to wrap). It's a separate constant for readability
// and so the SuburbPlot caller can drop the band without re-deriving
// the rule.

export const shouldShowImputedSeries = (filter: SourceFilter): boolean =>
	filter === "all" || filter === "imputed";

export const shouldShowForecast = (filter: SourceFilter): boolean =>
	filter === "all" || filter === "forecast";

export const shouldShowImputedBand = shouldShowImputedSeries;

// Keep only the SuburbTimeSeries entries the filter permits, and (when
// forecasts are hidden) strip the `forecast` field from the survivors so
// downstream `buildForecastTrace` calls return [].
export const filterSeries = (
	series: ReadonlyArray<SuburbTimeSeries>,
	filter: SourceFilter,
): SuburbTimeSeries[] => {
	const keepImputed = shouldShowImputedSeries(filter);
	const keepForecast = shouldShowForecast(filter);
	const out: SuburbTimeSeries[] = [];
	for (const s of series) {
		if (s.imputed && !keepImputed) continue;
		if (keepForecast) {
			out.push(s);
		} else {
			// Strip forecast — but only when there *is* one, so the
			// reference-equality path is preserved for forecast-less series
			// (matters for Plotly's deep-compare on re-render).
			if (s.forecast === undefined) {
				out.push(s);
			} else {
				const { forecast: _f, ...rest } = s;
				out.push(rest as SuburbTimeSeries);
			}
		}
	}
	return out;
};

// ---------------------------------------------------------------------------
// Yield-view filtering: yield series carry a composite per-point
// qualifier (observed / partially_imputed / fully_imputed / forecast).
// The "imputed" mode keeps observed + partially + fully; the "forecast"
// mode keeps observed + forecast; "observed" keeps only observed; "all"
// keeps everything.
// ---------------------------------------------------------------------------

export const filterYieldPoints = (
	points: ReadonlyArray<YieldPoint>,
	filter: SourceFilter,
): YieldPoint[] => {
	if (filter === "all") return [...points];
	return points.filter((p) => {
		if (p.qualifier === "observed") return true;
		if (p.qualifier === "forecast") return shouldShowForecast(filter);
		// partially_imputed / fully_imputed
		return shouldShowImputedSeries(filter);
	});
};

// Apply the point filter to every yield series. Series that end up
// empty are dropped so the renderer doesn't draw a phantom trace.
export const filterYieldSeries = (
	yields: ReadonlyArray<YieldSeries>,
	filter: SourceFilter,
): YieldSeries[] => {
	if (filter === "all") return [...yields];
	const out: YieldSeries[] = [];
	for (const y of yields) {
		const points = filterYieldPoints(y.points, filter);
		if (points.length === 0) continue;
		out.push({ ...y, points });
	}
	return out;
};

// Re-export of forecast type to keep call sites importing one module.
export type { ForecastPoint };
