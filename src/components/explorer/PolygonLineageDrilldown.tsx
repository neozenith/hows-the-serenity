// Per-polygon presence matrix for the /explore/overview drilldown.
//
// Given an arbitrary SAL or LGA code typed/picked by the analyst, plot
// a 3 × N (source-class × slice) grid showing where the polygon appears
// across observed / imputed / forecast for every (dwelling, bedrooms)
// slice. Each absent cell gets the recurring reason inherited from the
// already-classified slice lineage — so the analyst sees not just "X
// is missing" but "X is missing because P3 (below SARIMAX min-obs)".

import { useMemo, useState } from "react";

import {
	type LineagePattern,
	PATTERN_EXPLANATIONS,
	type SliceLineage,
} from "@/lib/cell-lineage";
import type { RegionTier } from "@/lib/overview-summary";

type SliceKey = string; // `${dwellingType}|${bedrooms}`

type PerPolygonPresence = {
	slices: ReadonlyArray<{ dwellingType: string; bedrooms: string }>;
	presence: ReadonlyMap<
		string,
		ReadonlyMap<SliceKey, { obs: boolean; imp: boolean; fc: boolean }>
	>;
	reasonForAbsent: ReadonlyMap<
		SliceKey,
		{
			obs: LineagePattern | null;
			imp: LineagePattern | null;
			fc: LineagePattern | null;
		}
	>;
};

const sliceKey = (dt: string, br: string): SliceKey => `${dt}|${br}`;

// Index every polygon across every slice + cohort. O(slices × polygons),
// computed once when slice lineages change.
const indexPresence = (
	slices: ReadonlyArray<SliceLineage>,
): PerPolygonPresence => {
	const sliceList = slices.map((s) => ({
		dwellingType: s.dwellingType,
		bedrooms: s.bedrooms,
	}));
	const presence = new Map<
		string,
		Map<SliceKey, { obs: boolean; imp: boolean; fc: boolean }>
	>();
	const reasonForAbsent = new Map<
		SliceKey,
		{
			obs: LineagePattern | null;
			imp: LineagePattern | null;
			fc: LineagePattern | null;
		}
	>();
	for (const s of slices) {
		const key = sliceKey(s.dwellingType, s.bedrooms);
		const observed = new Set(s.observed);
		const imputed = new Set(s.imputed);
		const forecast = new Set(s.forecast);
		const polygons = new Set([...observed, ...imputed, ...forecast]);
		for (const p of polygons) {
			let perPolygon = presence.get(p);
			if (!perPolygon) {
				perPolygon = new Map();
				presence.set(p, perPolygon);
			}
			perPolygon.set(key, {
				obs: observed.has(p),
				imp: imputed.has(p),
				fc: forecast.has(p),
			});
		}
		// Slice-level reasons: pick the dominant diff pattern for each cohort
		// (only the most informative — first diff that mentions the cohort).
		const reason = {
			obs: null as LineagePattern | null,
			imp: null as LineagePattern | null,
			fc: null as LineagePattern | null,
		};
		for (const d of s.diffs) {
			if (d.pair === "imp_minus_obs" || d.pair === "fc_minus_obs") {
				reason.obs = reason.obs ?? d.pattern;
			}
			if (d.pair === "obs_minus_imp" || d.pair === "fc_minus_imp") {
				reason.imp = reason.imp ?? d.pattern;
			}
			if (d.pair === "obs_minus_fc" || d.pair === "imp_minus_fc") {
				reason.fc = reason.fc ?? d.pattern;
			}
		}
		reasonForAbsent.set(key, reason);
	}
	return { slices: sliceList, presence, reasonForAbsent };
};

const dot = (present: boolean, cls: "obs" | "imp" | "fc"): string => {
	if (!present) return "·";
	if (cls === "obs") return "O";
	if (cls === "imp") return "I";
	return "F";
};

const COHORT_COLOR: Record<"obs" | "imp" | "fc", string> = {
	obs: "text-emerald-700 dark:text-emerald-300",
	imp: "text-indigo-700 dark:text-indigo-300",
	fc: "text-amber-700 dark:text-amber-300",
};

export const PolygonLineageDrilldown = ({
	tier,
	sliceLineages,
}: {
	tier: RegionTier;
	sliceLineages: ReadonlyArray<SliceLineage> | null;
}) => {
	const [code, setCode] = useState<string>("");

	const index = useMemo(
		() => (sliceLineages ? indexPresence(sliceLineages) : null),
		[sliceLineages],
	);

	const trimmed = code.trim();
	const perPolygon = index ? index.presence.get(trimmed) : undefined;
	const slices = index?.slices ?? [];
	const reasonMap = index?.reasonForAbsent;

	return (
		<section
			data-testid={`polygon-lineage-${tier}`}
			className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
		>
			<header className="mb-3 border-neutral-200 border-b pb-2 dark:border-neutral-800">
				<h2 className="font-medium text-base text-neutral-900 dark:text-neutral-100">
					Per-polygon lineage — {tier.toUpperCase()}
				</h2>
				<p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
					Type a {tier.toUpperCase()} code to see its presence across every
					(dwelling, bedrooms) slice and source cohort. Absent cells show the
					recurring reason classified at the slice level.
				</p>
			</header>
			<div className="mb-2 flex items-center gap-2">
				<label
					className="text-neutral-600 text-xs dark:text-neutral-400"
					htmlFor={`polygon-lineage-input-${tier}`}
				>
					{tier === "sal" ? "SAL_CODE21" : "LGA_CODE24"}:
				</label>
				<input
					id={`polygon-lineage-input-${tier}`}
					type="text"
					value={code}
					onChange={(e) => setCode(e.target.value)}
					placeholder={tier === "sal" ? "e.g. 20002" : "e.g. 24600"}
					data-testid={`polygon-lineage-input-${tier}`}
					className="rounded border border-neutral-300 px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
				/>
			</div>
			{trimmed.length === 0 ? (
				<p className="text-neutral-500 text-xs">
					Enter a code to see its lineage.
				</p>
			) : !index ? (
				<p className="text-neutral-500 text-xs">Lineage data still loading…</p>
			) : !perPolygon ? (
				<p
					className="text-amber-700 text-xs dark:text-amber-300"
					data-testid={`polygon-lineage-missing-${tier}`}
				>
					Code <span className="font-mono">{trimmed}</span> not found in any
					observed, imputed, or forecast cohort for any {tier.toUpperCase()}{" "}
					slice. (Vendor never published this polygon AND the impute step didn't
					reach it.)
				</p>
			) : (
				<div className="overflow-x-auto">
					<table
						className="min-w-full font-mono text-xs"
						data-testid={`polygon-lineage-table-${tier}`}
					>
						<thead>
							<tr className="border-neutral-200 border-b text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
								<th className="py-1 pr-3 text-left">Slice</th>
								<th className="py-1 pr-2 text-center">Obs</th>
								<th className="py-1 pr-2 text-center">Imp</th>
								<th className="py-1 pr-2 text-center">Fc</th>
								<th className="py-1 text-left">Reason for absences</th>
							</tr>
						</thead>
						<tbody>
							{slices.map((s) => {
								const key = sliceKey(s.dwellingType, s.bedrooms);
								const cell = perPolygon.get(key) ?? {
									obs: false,
									imp: false,
									fc: false,
								};
								const reasons = reasonMap?.get(key);
								const reasonParts: string[] = [];
								if (!cell.obs && reasons?.obs)
									reasonParts.push(`obs: ${reasons.obs}`);
								if (!cell.imp && reasons?.imp)
									reasonParts.push(`imp: ${reasons.imp}`);
								if (!cell.fc && reasons?.fc)
									reasonParts.push(`fc: ${reasons.fc}`);
								const reasonText = reasonParts.join(" · ");
								return (
									<tr
										key={key}
										className="border-neutral-100 border-b last:border-b-0 dark:border-neutral-800"
									>
										<td className="py-1 pr-3">
											{s.dwellingType}/{s.bedrooms}
										</td>
										<td className={`py-1 pr-2 text-center ${COHORT_COLOR.obs}`}>
											{dot(cell.obs, "obs")}
										</td>
										<td className={`py-1 pr-2 text-center ${COHORT_COLOR.imp}`}>
											{dot(cell.imp, "imp")}
										</td>
										<td className={`py-1 pr-2 text-center ${COHORT_COLOR.fc}`}>
											{dot(cell.fc, "fc")}
										</td>
										<td
											className="py-1 text-neutral-600 dark:text-neutral-300"
											title={reasonText}
										>
											{reasonText || "—"}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{perPolygon && (
				<p className="mt-2 text-neutral-500 text-[10px] dark:text-neutral-400">
					Hover the reason cell for the full pattern. Pattern catalogue:{" "}
					{Object.entries(PATTERN_EXPLANATIONS)
						.map(([k]) => k)
						.join(", ")}
					.
				</p>
			)}
		</section>
	);
};
