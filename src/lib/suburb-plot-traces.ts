// Pure-TS trace builders for SuburbPlot. Kept in `src/lib/` (the documented
// pure-TS test seam) so Vitest can exercise them without instantiating
// Plotly / React. The live Plotly render is covered by Playwright e2e.
//
// Visual language across all traces SuburbPlot draws:
//   - SOLID line     → vendor-observed data ("source")
//   - SHORT DOT line → imputed historical data ("estimate")
//   - LONG DASH line → SARIMAX forecast (continues either of the above)
//   - Filled bands   → σ uncertainty, alpha-tinted from the same series colour
//
// Colour is the SERIES-identity axis; dash patterns are the DATA-PROVENANCE
// axis. A series's observed history, its imputed history, its forecast
// continuation, and its uncertainty band all share one colour so the eye
// reads them as one trace family.

import type { ForecastPoint, SuburbTimeSeries } from "./rental-sales-query";

// Plotly's qualitative "Plotly" palette — 10 high-contrast colours that
// remain distinguishable to most colour-vision-deficient viewers. Indexed by
// the series's position in the sorted active subset (see compareSeries in
// SuburbPlot.tsx) so the same series always picks the same slot when the
// active view is rebuilt.
const PALETTE: ReadonlyArray<string> = [
	"#636EFA",
	"#EF553B",
	"#00CC96",
	"#AB63FA",
	"#FFA15A",
	"#19D3F3",
	"#FF6692",
	"#B6E880",
	"#FF97FF",
	"#FECB52",
];

export const colorForIndex = (i: number): string =>
	PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ??
	PALETTE[0]!;

// "#RRGGBB" → "rgba(R, G, B, a)" so band fills can share their series's hue
// at a low alpha without parsing colours at the call site.
export const hexToRgba = (hex: string, alpha: number): string => {
	const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = Number.parseInt(cleaned.slice(0, 2), 16);
	const g = Number.parseInt(cleaned.slice(2, 4), 16);
	const b = Number.parseInt(cleaned.slice(4, 6), 16);
	const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
	return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
};

// Human-readable trace label. Folded back from SuburbPlot.tsx so the
// forecast / imputed-band trace builders can use the same label format —
// keeps `House · 2 br` and `House · 2 br · forecast` visually paired in the
// Plotly legend.
const capitalize = (s: string): string =>
	s.length === 0 ? s : `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

export const traceLabel = (s: SuburbTimeSeries): string => {
	const dt = s.dwellingType;
	const br = s.bedrooms;
	if (dt === "all" && br === "all") return "All dwellings";
	if (br === "all") return capitalize(dt);
	if (dt === "all") return `All · ${br} br`;
	return `${capitalize(dt)} · ${br} br`;
};

// Stable key per series — used by SuburbPlot to build a colour map shared
// across the observed/imputed line, the forecast continuation, and the
// uncertainty band.
export const seriesColorKey = (s: SuburbTimeSeries): string =>
	`${s.dataType}|${s.dwellingType}|${s.bedrooms}`;

// Minimum trace shape SuburbPlot needs from us. Plotly's typings live in a
// separate ambient module; we model only the fields we set here so the
// caller can use them via structural compatibility.
export type ForecastTrace = {
	x: Date[];
	y: number[];
	type: "scatter";
	mode: "lines";
	name: string;
	line: {
		dash?: "dash" | "dot" | "longdash" | "longdashdot" | "dashdot" | "solid";
		width?: number;
		color?: string;
	};
	fill?: "tonexty";
	fillcolor?: string;
	showlegend?: boolean;
	hoverinfo?: "skip";
};

// Default interval levels per the G5 ADR: 95% outer + 80% inner. Loop in
// descending order so the wider band lays down first; Plotly's tonexty
// fills toward the previously-rendered trace.
export const DEFAULT_INTERVALS: ReadonlyArray<80 | 95> = [80, 95];

// z-score for the 95% two-sided normal interval. SARIMAX emits
// y_hat ± Z_95 * σ at the smallest forecast horizon (1-step-ahead variance
// ≈ residual variance), so we invert the interval to recover σ for the
// imputed-historical band.
const Z_95 = 1.959963984540054;

// Default band alpha for the 95% level when no per-series colour is given.
// 80% bands use a higher alpha so the inner band reads as the "more likely"
// region without overwhelming the line.
const ALPHA_BY_LEVEL: Record<number, number> = { 80: 0.18, 95: 0.1 };

const bandFill = (color: string | undefined, level: number): string => {
	const alpha = ALPHA_BY_LEVEL[level] ?? 0.1;
	if (color?.startsWith("#")) return hexToRgba(color, alpha);
	// Fallback indigo when no per-series colour is given — pre-colour-matching
	// callers preserved.
	return `rgba(109, 40, 217, ${(0.06 + 0.1 * (level === 80 ? 1 : 0.5)).toFixed(2)})`;
};

// Render the per-series forecast continuation. Returns an empty array when
// no forecast data is present, so the caller can `concat` the result into
// the main `data` array unconditionally.
//
// Trace ordering matters for Plotly's `fill: 'tonexty'`:
//   1. For each interval level descending (95 → 80):
//      - invisible upper-bound anchor (no fill, line.width=0)
//      - filled lower-bound (fill='tonexty', fills toward the anchor above)
//   2. Long-dash point-forecast line on top of the bands, in the matched
//      series colour.
//
// Series whose forecast has NULL bound values (e.g. bedroom-borrowed rows)
// skip the band traces and emit only the point-forecast line — the NULL
// path is honest: "we have a point estimate but no statistical interval."
export const buildForecastTrace = (
	series: SuburbTimeSeries,
	intervals: ReadonlyArray<80 | 95> = DEFAULT_INTERVALS,
	color?: string,
): ForecastTrace[] => {
	const forecast = series.forecast;
	if (!forecast || forecast.length === 0) return [];

	const traceName = `${traceLabel(series)} · forecast`;
	const x = forecast.map((p) => p.ts);

	const traces: ForecastTrace[] = [];

	// Interval bands — descending so the wider 95% lays down first and the
	// narrower 80% paints on top.
	const sortedDesc = [...intervals].sort((a, b) => b - a);
	for (const level of sortedDesc) {
		const upperKey = `hi${level}` as keyof ForecastPoint;
		const lowerKey = `lo${level}` as keyof ForecastPoint;
		const upper = forecast.map((p) => p[upperKey] as number | null);
		const lower = forecast.map((p) => p[lowerKey] as number | null);
		// Skip the band if any row has NULL bounds (e.g. bedroom-borrowed).
		if (upper.some((v) => v === null) || lower.some((v) => v === null)) {
			continue;
		}
		traces.push({
			x,
			y: upper as number[],
			type: "scatter",
			mode: "lines",
			name: `${traceName} ${level}% upper`,
			line: { width: 0 },
			showlegend: false,
			hoverinfo: "skip",
		});
		traces.push({
			x,
			y: lower as number[],
			type: "scatter",
			mode: "lines",
			name: `${traceName} ${level}%`,
			line: { width: 0 },
			fill: "tonexty",
			fillcolor: bandFill(color, level),
			showlegend: false,
			hoverinfo: "skip",
		});
	}

	// Point-forecast line — long-dash, in the matched series colour so the
	// observed + forecast read as one trace family.
	traces.push({
		x,
		y: forecast.map((p) => p.yHat),
		type: "scatter",
		mode: "lines",
		name: traceName,
		line: { dash: "longdash", width: 2, ...(color ? { color } : {}) },
	});

	return traces;
};

// Recover the SARIMAX in-sample residual σ from a series's smallest-horizon
// forecast row. The bake emits y_hat_lo_95 / y_hat_hi_95 as y_hat ± Z_95·σ,
// so width / (2·Z_95) inverts it. The forecast array is ORDER BY ds asc, so
// forecast[0] is the smallest available horizon — at h=1 this is essentially
// the residual σ; at larger h the inverted figure overstates σ slightly
// (forecast variance grows with horizon), but never understates, which is
// the conservative direction for a "this is imputed, not measured" band.
//
// Returns null when no forecast exists or the bounds are NULL (e.g.
// bedroom-borrowed forecasts skip statistical intervals) — the caller drops
// the band and the imputed line still renders as dotted with the label.
export const recoverSigmaFromForecast = (
	forecast: ReadonlyArray<ForecastPoint> | undefined,
): number | null => {
	if (!forecast || forecast.length === 0) return null;
	const f = forecast[0];
	if (f === undefined || f.hi95 == null || f.lo95 == null) return null;
	const sigma = (f.hi95 - f.lo95) / (2 * Z_95);
	return Number.isFinite(sigma) && sigma > 0 ? sigma : null;
};

// Constant-width ±Z_95·σ fill band over the imputed historical points,
// rendered the same way as forecast bands: an invisible upper anchor
// followed by a filled lower bound (Plotly `fill: "tonexty"`). Fillcolor
// matches the series colour at a low alpha so the band reads as "this
// series's uncertainty" rather than a competing concept.
//
// Returns [] when the series isn't imputed, has no points, or no σ was
// recovered — caller can spread into the traces array unconditionally.
export const buildImputedBandTrace = (
	series: SuburbTimeSeries,
	sigma: number | null,
	color?: string,
): ForecastTrace[] => {
	if (!series.imputed || sigma == null || series.points.length === 0) return [];
	const margin = Z_95 * sigma;
	const x = series.points.map((p) => p.ts);
	const upper = series.points.map((p) => p.value + margin);
	const lower = series.points.map((p) => p.value - margin);
	const base = `${traceLabel(series)} · imputed σ`;
	return [
		{
			x,
			y: upper,
			type: "scatter",
			mode: "lines",
			name: `${base} upper`,
			line: { width: 0 },
			showlegend: false,
			hoverinfo: "skip",
		},
		{
			x,
			y: lower,
			type: "scatter",
			mode: "lines",
			name: `${base} lower`,
			line: { width: 0 },
			fill: "tonexty",
			fillcolor: bandFill(color, 95),
			showlegend: false,
			hoverinfo: "skip",
		},
	];
};
