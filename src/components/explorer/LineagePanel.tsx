// /explore/overview lineage panel — pairwise set-diff audit per tier.
//
// For every (dwelling, bedrooms) slice in the tier, computes the six
// pairwise diffs (obs/imp/fc) and classifies each into one of the
// recurring patterns P1–P6 (see src/lib/cell-lineage.ts). Then rolls
// the diffs up by pattern so the analyst sees, per tier:
//
//   "P2 OBSERVED_NOT_REIMPUTED affects 6 slices, 1,372 polygon
//    appearances — impute is idempotent, this is expected. Click to
//    paint the affected polygons on the map below."
//
// The summary is the answer to "why are the numbers weird?". The
// click-to-paint loops the analyst back to the geographic view to
// verify the reason visually.

import { useMemo, useState } from "react";

import {
	type LineagePattern,
	type PairKind,
	type PatternRollup,
	rollupByPattern,
	type SliceLineage,
} from "@/lib/cell-lineage";
import type { RegionTier } from "@/lib/overview-summary";

const PAIR_LABEL: Record<PairKind, string> = {
	obs_minus_imp: "observed ∖ imputed",
	imp_minus_obs: "imputed ∖ observed",
	obs_minus_fc: "observed ∖ forecast",
	fc_minus_obs: "forecast ∖ observed",
	imp_minus_fc: "imputed ∖ forecast",
	fc_minus_imp: "forecast ∖ imputed",
};

const PATTERN_BADGE: Record<LineagePattern, string> = {
	P1_VENDOR_GAP:
		"bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
	P2_OBSERVED_NOT_REIMPUTED:
		"bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
	P3_BELOW_SARIMAX_MIN_OBS:
		"bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
	P4_CROSS_TIER_IMPUTE_EXPANSION:
		"bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
	P5_MULTI_SAL_GROUP_EDGE_CASE:
		"bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
	P6_UNCLASSIFIED:
		"bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
};

export type LineageSelection = {
	pattern: LineagePattern;
	polygons: string[];
	label: string;
};

export const LineagePanel = ({
	tier,
	sliceLineages,
	onSelectPolygons,
}: {
	tier: RegionTier;
	sliceLineages: ReadonlyArray<SliceLineage> | null;
	onSelectPolygons: (selection: LineageSelection) => void;
}) => {
	const [activePattern, setActivePattern] = useState<LineagePattern | null>(
		null,
	);

	const rollups = useMemo<PatternRollup[]>(
		() => (sliceLineages ? rollupByPattern(sliceLineages) : []),
		[sliceLineages],
	);

	const handlePatternClick = (rollup: PatternRollup) => {
		setActivePattern(rollup.pattern);
		onSelectPolygons({
			pattern: rollup.pattern,
			polygons: [...rollup.uniquePolygons],
			label: `${rollup.pattern
				.replace(/^P\d+_/, "")
				.replace(/_/g, " ")
				.toLowerCase()} · ${rollup.uniquePolygons.length.toLocaleString()} unique polygons across ${rollup.slicesAffected} slice${rollup.slicesAffected === 1 ? "" : "s"}`,
		});
	};

	if (!sliceLineages) {
		return (
			<div
				className="p-3 text-neutral-500 text-sm"
				data-testid={`lineage-loading-${tier}`}
			>
				Classifying {tier.toUpperCase()} lineage…
			</div>
		);
	}

	if (rollups.length === 0) {
		return (
			<div
				className="p-3 text-emerald-700 text-sm dark:text-emerald-300"
				data-testid={`lineage-clean-${tier}`}
			>
				All {tier.toUpperCase()} slices fully reconciled — observed, imputed,
				and forecast cover identical polygon sets.
			</div>
		);
	}

	return (
		<section
			data-testid={`lineage-panel-${tier}`}
			className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
		>
			<header className="mb-3 border-neutral-200 border-b pb-2 dark:border-neutral-800">
				<h2 className="font-medium text-base text-neutral-900 dark:text-neutral-100">
					{tier.toUpperCase()} lineage — why the numbers differ
				</h2>
				<p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
					Every (dwelling, bedrooms) slice's pairwise set-difference (observed ↔
					imputed ↔ forecast) classified into one of the recurring patterns
					below. Click a pattern to paint the affected polygons on the map
					above.
				</p>
			</header>
			<ul className="space-y-2">
				{rollups.map((r) => {
					const active = activePattern === r.pattern;
					return (
						<li
							key={r.pattern}
							data-testid={`lineage-pattern-${tier}-${r.pattern}`}
							className={[
								"rounded-md border p-2",
								active
									? "border-indigo-400 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/40"
									: "border-neutral-200 dark:border-neutral-800",
							].join(" ")}
						>
							<button
								type="button"
								onClick={() => handlePatternClick(r)}
								className="w-full text-left"
								aria-pressed={active}
							>
								<div className="flex flex-wrap items-baseline gap-2">
									<span
										className={[
											"rounded px-2 py-0.5 font-medium text-xs",
											PATTERN_BADGE[r.pattern],
										].join(" ")}
									>
										{r.pattern}
									</span>
									<span className="text-neutral-900 text-sm dark:text-neutral-100">
										{r.slicesAffected} slice{r.slicesAffected === 1 ? "" : "s"}{" "}
										· {r.uniquePolygons.length.toLocaleString()} unique polygons
									</span>
									<span className="text-neutral-500 text-xs dark:text-neutral-400">
										({r.totalPolygonAppearances.toLocaleString()} total
										appearances across diffs)
									</span>
								</div>
								<p className="mt-1 text-neutral-700 text-xs dark:text-neutral-300">
									{r.explanation}
								</p>
								{r.examples.length > 0 && (
									<details className="mt-1.5">
										<summary className="cursor-pointer text-neutral-500 text-xs hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
											Top contributing slices ({r.examples.length})
										</summary>
										<ul className="mt-1 space-y-0.5 pl-3 text-neutral-600 text-xs dark:text-neutral-300">
											{r.examples.map((ex) => (
												<li
													key={`${ex.dwellingType}|${ex.bedrooms}|${ex.pair}`}
												>
													<span className="font-mono">
														{ex.dwellingType}/{ex.bedrooms}
													</span>{" "}
													— {PAIR_LABEL[ex.pair]}:{" "}
													<strong>{ex.count.toLocaleString()}</strong> polygons
												</li>
											))}
										</ul>
									</details>
								)}
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
};
