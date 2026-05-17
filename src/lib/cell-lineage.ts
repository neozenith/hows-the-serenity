// Pairwise set-diff classifier for the /explore/overview lineage panel.
//
// Six recurring patterns explain ~all the disagreement between a slice's
// observed / imputed / forecast polygon sets. The webapp surfaces a
// summary per pattern instead of a raw set-diff dump (which would be
// 22k+ rows of polygon codes across 36 slices × 6 pairwise comparisons).
//
// Pattern catalogue (derived from a one-shot DuckDB exploration; see
// docs/specs/impute.md for the formal definition of each impute class):
//
//   P1 VENDOR_GAP                  obs = ∅,  imp > 0 — vendor doesn't
//                                  ship this slice, impute fills it
//                                  from scratch (e.g. LGA house all).
//
//   P2 OBSERVED_NOT_REIMPUTED      obs > imp — impute is idempotent and
//                                  doesn't re-write observed cells; the
//                                  "missing" imputation is intentional.
//
//   P3 BELOW_SARIMAX_MIN_OBS       obs > fc or imp > fc — series with
//                                  fewer than the bake's minimum obs
//                                  count are skipped by SARIMAX.
//
//   P4 CROSS_TIER_IMPUTE_EXPANSION imp >> obs — Class C/D derives this
//                                  slice via cross-tier signal, reaching
//                                  polygons the vendor never touched.
//
//   P5 MULTI_SAL_GROUP_EDGE_CASE   small diff (1-2 polygons) — vendor
//                                  multi-SAL groups split unevenly
//                                  between observed and downstream.
//
//   P6 UNCLASSIFIED                falls through none of the above —
//                                  surfaced loudly so the analyst can
//                                  extend the rule set.

export type LineagePattern =
	| "P1_VENDOR_GAP"
	| "P2_OBSERVED_NOT_REIMPUTED"
	| "P3_BELOW_SARIMAX_MIN_OBS"
	| "P4_CROSS_TIER_IMPUTE_EXPANSION"
	| "P5_MULTI_SAL_GROUP_EDGE_CASE"
	| "P6_UNCLASSIFIED";

export type PairKind =
	| "obs_minus_imp"
	| "imp_minus_obs"
	| "obs_minus_fc"
	| "fc_minus_obs"
	| "imp_minus_fc"
	| "fc_minus_imp";

export type PairwiseDiff = {
	pair: PairKind;
	pattern: LineagePattern;
	polygons: ReadonlyArray<string>;
	explanation: string;
};

export type SliceLineage = {
	dwellingType: string;
	bedrooms: string;
	observed: ReadonlyArray<string>;
	imputed: ReadonlyArray<string>;
	forecast: ReadonlyArray<string>;
	diffs: ReadonlyArray<PairwiseDiff>;
};

export const PATTERN_EXPLANATIONS: Record<LineagePattern, string> = {
	P1_VENDOR_GAP:
		"Vendor publishes nothing for this slice; the impute step fills the entire polygon population from scratch (e.g. LGA house-all, LGA unit-all, SAL all-all).",
	P2_OBSERVED_NOT_REIMPUTED:
		"Impute is idempotent — it only writes rows where vendor data is missing. Observed polygons that already have a value are intentionally not re-imputed, so observed - imputed is expected to be positive.",
	P3_BELOW_SARIMAX_MIN_OBS:
		"Forecast bake skips series with fewer than ~40 quarterly observations (spec G2). Polygons present in observed/imputed but absent from forecast usually fall under this threshold.",
	P4_CROSS_TIER_IMPUTE_EXPANSION:
		"Class C/D impute derives this slice via cross-tier signal (e.g. SAL sales-all-all built from rental cross-suburb weighted mix), so the imputed cohort can be far larger than what the raw observed feed touched.",
	P5_MULTI_SAL_GROUP_EDGE_CASE:
		"The vendor publishes some neighbouring SALs as a single group key (e.g. '20018-21677'). After flattening, a polygon can appear in one cohort but not another by 1-2 rows — usually a rounding/grouping artefact.",
	P6_UNCLASSIFIED:
		"This diff doesn't match any of the catalogued patterns. Investigate manually.",
};

// Heuristic thresholds derived from the one-shot exploration. P5
// captures small-diff noise (≤2 polygons); P3 captures the "below-min"
// gap which empirically stays single-digit for any individual slice;
// everything else gets routed by relative sizes.
const SMALL_DIFF_LIMIT = 2;

const setDiff = (
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>,
): string[] => {
	const bs = new Set(b);
	return [...new Set(a)].filter((x) => !bs.has(x)).sort();
};

const classify = (
	pair: PairKind,
	obs: ReadonlyArray<string>,
	imp: ReadonlyArray<string>,
	fc: ReadonlyArray<string>,
	diff: ReadonlyArray<string>,
): LineagePattern => {
	if (diff.length === 0) return "P6_UNCLASSIFIED"; // no diff → caller filters out
	switch (pair) {
		case "imp_minus_obs":
			// imp - obs > 0 means impute added polygons.
			// If obs is empty entirely, it's a 100% vendor gap.
			if (obs.length === 0) return "P1_VENDOR_GAP";
			// If impute added many polygons (>10× observed scale or just
			// numerically large), it's the cross-tier expansion path.
			if (diff.length > 50) return "P4_CROSS_TIER_IMPUTE_EXPANSION";
			if (diff.length <= SMALL_DIFF_LIMIT)
				return "P5_MULTI_SAL_GROUP_EDGE_CASE";
			return "P4_CROSS_TIER_IMPUTE_EXPANSION";
		case "obs_minus_imp":
			// obs - imp > 0 → idempotent skip of observed cells.
			if (diff.length <= SMALL_DIFF_LIMIT)
				return "P5_MULTI_SAL_GROUP_EDGE_CASE";
			return "P2_OBSERVED_NOT_REIMPUTED";
		case "obs_minus_fc":
		case "imp_minus_fc":
			// Polygons present upstream but missing from forecast — the
			// SARIMAX min-obs filter is the dominant cause.
			if (diff.length <= SMALL_DIFF_LIMIT)
				return "P5_MULTI_SAL_GROUP_EDGE_CASE";
			return "P3_BELOW_SARIMAX_MIN_OBS";
		case "fc_minus_obs":
		case "fc_minus_imp":
			// Forecast surfaced polygons not in observed/imputed.
			// Usually means imputation added them (fc inherits imp).
			if (fc.length > 0 && (obs.length === 0 || imp.length === 0))
				return "P1_VENDOR_GAP";
			if (diff.length <= SMALL_DIFF_LIMIT)
				return "P5_MULTI_SAL_GROUP_EDGE_CASE";
			return "P4_CROSS_TIER_IMPUTE_EXPANSION";
	}
};

// All 6 pairwise diffs for a single slice's (obs, imp, fc) sets, each
// classified into one of the recurring patterns. Diffs with zero
// elements are omitted — the slice is fully reconciled along that axis.
export const classifyPairwiseDiffs = (
	dwellingType: string,
	bedrooms: string,
	observed: ReadonlyArray<string>,
	imputed: ReadonlyArray<string>,
	forecast: ReadonlyArray<string>,
): SliceLineage => {
	const pairs: Array<{ pair: PairKind; diff: string[] }> = [
		{ pair: "obs_minus_imp", diff: setDiff(observed, imputed) },
		{ pair: "imp_minus_obs", diff: setDiff(imputed, observed) },
		{ pair: "obs_minus_fc", diff: setDiff(observed, forecast) },
		{ pair: "fc_minus_obs", diff: setDiff(forecast, observed) },
		{ pair: "imp_minus_fc", diff: setDiff(imputed, forecast) },
		{ pair: "fc_minus_imp", diff: setDiff(forecast, imputed) },
	];

	const diffs: PairwiseDiff[] = pairs
		.filter((p) => p.diff.length > 0)
		.map(({ pair, diff }) => {
			const pattern = classify(pair, observed, imputed, forecast, diff);
			return {
				pair,
				pattern,
				polygons: diff,
				explanation: PATTERN_EXPLANATIONS[pattern],
			};
		});

	return {
		dwellingType,
		bedrooms,
		observed,
		imputed,
		forecast,
		diffs,
	};
};

export type PatternRollup = {
	pattern: LineagePattern;
	explanation: string;
	slicesAffected: number;
	totalPolygonAppearances: number;
	uniquePolygons: ReadonlyArray<string>;
	examples: ReadonlyArray<{
		dwellingType: string;
		bedrooms: string;
		pair: PairKind;
		count: number;
	}>;
};

// Aggregate a list of per-slice lineages into one entry per pattern.
// The webapp lists the patterns in order of "loudness" (number of
// distinct slices affected) so the most pervasive issue surfaces first.
export const rollupByPattern = (
	slices: ReadonlyArray<SliceLineage>,
): PatternRollup[] => {
	const buckets = new Map<
		LineagePattern,
		{
			slices: Set<string>;
			polygonAppearances: number;
			uniquePolygons: Set<string>;
			examples: Array<{
				dwellingType: string;
				bedrooms: string;
				pair: PairKind;
				count: number;
			}>;
		}
	>();

	for (const slice of slices) {
		for (const diff of slice.diffs) {
			let b = buckets.get(diff.pattern);
			if (!b) {
				b = {
					slices: new Set(),
					polygonAppearances: 0,
					uniquePolygons: new Set(),
					examples: [],
				};
				buckets.set(diff.pattern, b);
			}
			b.slices.add(`${slice.dwellingType}|${slice.bedrooms}`);
			b.polygonAppearances += diff.polygons.length;
			for (const p of diff.polygons) b.uniquePolygons.add(p);
			b.examples.push({
				dwellingType: slice.dwellingType,
				bedrooms: slice.bedrooms,
				pair: diff.pair,
				count: diff.polygons.length,
			});
		}
	}

	return [...buckets.entries()]
		.map(([pattern, b]) => ({
			pattern,
			explanation: PATTERN_EXPLANATIONS[pattern],
			slicesAffected: b.slices.size,
			totalPolygonAppearances: b.polygonAppearances,
			uniquePolygons: [...b.uniquePolygons].sort(),
			examples: b.examples.sort((a, b1) => b1.count - a.count).slice(0, 5),
		}))
		.sort((a, b) => b.slicesAffected - a.slicesAffected);
};
