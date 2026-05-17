// /explore/overview — coverage matrix for both SAL and LGA tiers + a
// click-to-inspect polygon overlay per tier.
//
// Four questions answered, in this order:
//   1. How many regions exist in the tier universe?            (region_totals.json)
//   2. How many have observed (non-imputed) source data?       (region_totals.json)
//   3. Per (dwelling_type, bedrooms) — how many POLYGONS are
//      represented in observed, imputed, and forecast tables?  (DuckDB UNION,
//      with vendor multi-SAL group strings flattened so the count matches
//      what the polygon overlay paints)
//   4. Which polygons exactly? Click any cell → Deck.GL map under the
//      tier table renders ONLY those polygons.
//
// All numeric reshaping happens in the pure `summariseCoverageRows` helper
// (src/lib/overview-summary.ts) which is independently unit-tested.
// Vendor multi-SAL groups are flattened by `flattenCellCodes` from
// cell-polygons.ts (also unit-tested).

import { useCallback, useEffect, useMemo, useState } from "react";

import {
	LineagePanel,
	type LineageSelection,
} from "@/components/explorer/LineagePanel";
import { PolygonLineageDrilldown } from "@/components/explorer/PolygonLineageDrilldown";
import {
	type PolygonFeatureCollection,
	TierPolygonMap,
} from "@/components/explorer/TierPolygonMap";
import { classifyPairwiseDiffs, type SliceLineage } from "@/lib/cell-lineage";
import { flattenCellCodes } from "@/lib/cell-polygons";
import { versionedUrl } from "@/lib/data-version";
import {
	type CoverageSlice,
	type RegionTier,
	type RegionTotals,
	summariseCoverageRows,
	type TierSummary,
} from "@/lib/overview-summary";
import {
	type CoverageRow,
	queryCoverageRows,
	queryRegionCodesForCell,
} from "@/lib/rental-sales-query";

type SourceClass = "observed" | "imputed" | "forecast";

type SelectedCell = {
	dwellingType: string;
	bedrooms: string;
	sourceClass: SourceClass;
	codes: ReadonlyArray<string>;
};

const GEOJSON_PATH: Record<RegionTier, string> = {
	sal: "data/selected_sal_2021_aust_gda2020.geojson",
	lga: "data/selected_lga_2024_aust_gda2020.geojson",
};

const loadRegionTotals = async (): Promise<RegionTotals> => {
	const res = await fetch(versionedUrl("data/region_totals.json"));
	if (!res.ok)
		throw new Error(`region_totals.json fetch failed: ${res.status}`);
	return (await res.json()) as RegionTotals;
};

const loadGeoJson = async (
	tier: RegionTier,
): Promise<PolygonFeatureCollection> => {
	const res = await fetch(versionedUrl(GEOJSON_PATH[tier]));
	if (!res.ok) throw new Error(`${tier} geojson fetch failed: ${res.status}`);
	return (await res.json()) as PolygonFeatureCollection;
};

const cellLabel = (cell: SelectedCell): string =>
	`${cell.sourceClass} · ${cell.dwellingType} / ${cell.bedrooms}br · ${cell.codes.length.toLocaleString()} polygons`;

const cellNumberClass = (n: number, denom: number, active: boolean): string => {
	const base = active
		? "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/60 dark:text-indigo-100"
		: "hover:bg-neutral-100 dark:hover:bg-neutral-800";
	if (denom <= 0 || n === 0)
		return `${base} text-neutral-400 dark:text-neutral-600`;
	if (n >= denom)
		return `${base} font-medium text-emerald-700 dark:text-emerald-300`;
	return `${base} text-neutral-700 dark:text-neutral-200`;
};

const TierBlock = ({
	summary,
	selected,
	onCellClick,
}: {
	summary: TierSummary;
	selected: SelectedCell | null;
	onCellClick: (slice: CoverageSlice, sourceClass: SourceClass) => void;
}) => {
	const tierLabel = summary.tier.toUpperCase();
	const denom = summary.totalRegions;
	const observedPct =
		denom > 0 ? Math.round((summary.observedRegions / denom) * 100) : 0;
	const isActive = (slice: CoverageSlice, sc: SourceClass): boolean =>
		selected !== null &&
		selected.dwellingType === slice.dwellingType &&
		selected.bedrooms === slice.bedrooms &&
		selected.sourceClass === sc;

	const cellButton = (slice: CoverageSlice, sc: SourceClass, n: number) => (
		<button
			type="button"
			onClick={() => onCellClick(slice, sc)}
			data-testid={`overview-cell-${summary.tier}-${slice.dwellingType}-${slice.bedrooms}-${sc}`}
			aria-pressed={isActive(slice, sc)}
			className={[
				"block w-full rounded-sm px-2 py-1 text-right font-mono tabular-nums transition-colors",
				cellNumberClass(n, denom, isActive(slice, sc)),
			].join(" ")}
		>
			{n.toLocaleString()}
		</button>
	);

	return (
		<section
			data-testid={`overview-tier-${summary.tier}`}
			className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
		>
			<header className="mb-3 flex flex-wrap items-baseline gap-3 border-neutral-200 border-b pb-2 dark:border-neutral-800">
				<h2 className="font-medium text-base text-neutral-900 dark:text-neutral-100">
					{tierLabel}s
				</h2>
				<span className="text-neutral-600 text-sm dark:text-neutral-400">
					<strong
						className="text-neutral-900 dark:text-neutral-100"
						data-testid={`overview-${summary.tier}-total`}
					>
						{summary.totalRegions.toLocaleString()}
					</strong>{" "}
					polygons in Victoria
				</span>
				<span className="text-neutral-600 text-sm dark:text-neutral-400">
					<strong
						className="text-neutral-900 dark:text-neutral-100"
						data-testid={`overview-${summary.tier}-observed`}
					>
						{summary.observedRegions.toLocaleString()}
					</strong>{" "}
					with observed source data ({observedPct}%)
				</span>
			</header>
			{summary.slices.length === 0 ? (
				<p className="text-neutral-500 text-sm">
					No coverage rows for {tierLabel}.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="min-w-full text-sm">
						<thead>
							<tr className="border-neutral-200 border-b text-left text-neutral-500 text-xs uppercase tracking-wide dark:border-neutral-800 dark:text-neutral-400">
								<th className="py-1.5 pr-3">Dwelling</th>
								<th className="py-1.5 pr-3">Bedrooms</th>
								<th className="py-1.5 pr-3 text-right">Observed</th>
								<th className="py-1.5 pr-3 text-right">Imputed</th>
								<th className="py-1.5 text-right">Forecast</th>
							</tr>
						</thead>
						<tbody>
							{summary.slices.map((s) => (
								<tr
									key={`${s.dwellingType}-${s.bedrooms}`}
									data-testid={`overview-${summary.tier}-row`}
									data-dwelling={s.dwellingType}
									data-bedrooms={s.bedrooms}
									className="border-neutral-100 border-b last:border-b-0 dark:border-neutral-800"
								>
									<td className="py-1 pr-3 font-mono">{s.dwellingType}</td>
									<td className="py-1 pr-3 font-mono">{s.bedrooms}</td>
									<td className="py-1 pr-3">
										{cellButton(s, "observed", s.observed)}
									</td>
									<td className="py-1 pr-3">
										{cellButton(s, "imputed", s.imputed)}
									</td>
									<td className="py-1">
										{cellButton(s, "forecast", s.forecast)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
};

export const OverviewSummary = () => {
	const [totals, setTotals] = useState<RegionTotals | null>(null);
	const [rows, setRows] = useState<CoverageRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Selected cell + lazy-loaded geojson, kept per tier so a SAL click
	// doesn't reset the LGA map and vice versa.
	const [salSelected, setSalSelected] = useState<SelectedCell | null>(null);
	const [lgaSelected, setLgaSelected] = useState<SelectedCell | null>(null);
	const [salGeojson, setSalGeojson] = useState<PolygonFeatureCollection | null>(
		null,
	);
	const [lgaGeojson, setLgaGeojson] = useState<PolygonFeatureCollection | null>(
		null,
	);
	// Full per-slice lineage (observed/imputed/forecast polygon sets +
	// pairwise-diff classification) is computed once per tier in this
	// component so the LineagePanel + PolygonLineageDrilldown can share
	// the same indexed data without re-querying DuckDB.
	const [salLineages, setSalLineages] = useState<SliceLineage[] | null>(null);
	const [lgaLineages, setLgaLineages] = useState<SliceLineage[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		Promise.all([loadRegionTotals(), queryCoverageRows()])
			.then(([t, r]) => {
				if (cancelled) return;
				setTotals(t);
				setRows(r);
			})
			.catch((err: unknown) => {
				if (!cancelled)
					setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleCellClick = useCallback(
		(
			tier: RegionTier,
			slice: CoverageSlice,
			sourceClass: SourceClass,
		): void => {
			// Lazy-load the geojson the first time a cell in this tier is
			// clicked. SAL is 11 MB so this matters for first-paint TTI.
			if (tier === "sal" && !salGeojson)
				loadGeoJson("sal")
					.then(setSalGeojson)
					.catch((err: unknown) =>
						setError(err instanceof Error ? err.message : String(err)),
					);
			if (tier === "lga" && !lgaGeojson)
				loadGeoJson("lga")
					.then(setLgaGeojson)
					.catch((err: unknown) =>
						setError(err instanceof Error ? err.message : String(err)),
					);

			queryRegionCodesForCell(
				tier,
				slice.dwellingType,
				slice.bedrooms,
				sourceClass,
			)
				.then((rowKeys) => {
					const codes = flattenCellCodes(rowKeys);
					const cell: SelectedCell = {
						dwellingType: slice.dwellingType,
						bedrooms: slice.bedrooms,
						sourceClass,
						codes,
					};
					if (tier === "sal") setSalSelected(cell);
					else setLgaSelected(cell);
				})
				.catch((err: unknown) =>
					setError(err instanceof Error ? err.message : String(err)),
				);
		},
		[salGeojson, lgaGeojson],
	);

	const summaries = useMemo(
		() => (rows && totals ? summariseCoverageRows(rows, totals) : []),
		[rows, totals],
	);

	useEffect(() => {
		if (summaries.length === 0) return;
		let cancelled = false;
		const buildLineage = async (
			tier: RegionTier,
			slices: TierSummary["slices"],
		): Promise<SliceLineage[]> => {
			const results = await Promise.all(
				slices.map(async (sl) => {
					const [obs, imp, fc] = await Promise.all([
						queryRegionCodesForCell(
							tier,
							sl.dwellingType,
							sl.bedrooms,
							"observed",
						),
						queryRegionCodesForCell(
							tier,
							sl.dwellingType,
							sl.bedrooms,
							"imputed",
						),
						queryRegionCodesForCell(
							tier,
							sl.dwellingType,
							sl.bedrooms,
							"forecast",
						),
					]);
					return classifyPairwiseDiffs(
						sl.dwellingType,
						sl.bedrooms,
						flattenCellCodes(obs),
						flattenCellCodes(imp),
						flattenCellCodes(fc),
					);
				}),
			);
			return results;
		};
		for (const s of summaries) {
			buildLineage(s.tier, s.slices)
				.then((lin) => {
					if (cancelled) return;
					if (s.tier === "sal") setSalLineages(lin);
					else setLgaLineages(lin);
				})
				.catch((err: unknown) =>
					setError(err instanceof Error ? err.message : String(err)),
				);
		}
		return () => {
			cancelled = true;
		};
	}, [summaries]);

	if (error) {
		return (
			<div
				className="p-4 text-red-600 text-sm dark:text-red-300"
				data-testid="overview-error"
			>
				Failed to load coverage summary: {error}
			</div>
		);
	}

	if (!totals || !rows) {
		return (
			<div
				className="p-4 text-neutral-500 text-sm"
				data-testid="overview-loading"
			>
				Loading coverage summary…
			</div>
		);
	}

	const selectedFor = (tier: RegionTier): SelectedCell | null =>
		tier === "sal" ? salSelected : lgaSelected;
	const geojsonFor = (tier: RegionTier): PolygonFeatureCollection | null =>
		tier === "sal" ? salGeojson : lgaGeojson;

	return (
		<div
			className="h-full space-y-4 overflow-y-auto p-3"
			data-testid="overview-root"
		>
			<header className="border-neutral-200 border-b pb-3 dark:border-neutral-800">
				<h1 className="font-medium text-lg text-neutral-900 dark:text-neutral-100">
					Coverage overview
				</h1>
				<p className="mt-1 text-neutral-600 text-sm dark:text-neutral-400">
					How many polygons we have data for, per region tier and per (dwelling,
					bedrooms) slice. Observed = source rows from the vendor feed. Imputed
					= synthesised rows from the impute step. Forecast = series the SARIMAX
					bake produced predictions for. Cell counts are flattened to individual
					polygons — vendor multi-SAL row strings like "20018-21677" contribute
					to both polygons. Click a cell to paint exactly those polygons on the
					map below the tier table.
				</p>
			</header>
			<div className="space-y-4">
				{summaries.map((s) => {
					const selected = selectedFor(s.tier);
					const handleLineagePick = (sel: LineageSelection): void => {
						// Lazy-load the geojson if we haven't already, then paint
						// the union of polygons the pattern affects on the
						// tier's existing TierPolygonMap.
						if (s.tier === "sal" && !salGeojson)
							loadGeoJson("sal")
								.then(setSalGeojson)
								.catch((err: unknown) =>
									setError(err instanceof Error ? err.message : String(err)),
								);
						if (s.tier === "lga" && !lgaGeojson)
							loadGeoJson("lga")
								.then(setLgaGeojson)
								.catch((err: unknown) =>
									setError(err instanceof Error ? err.message : String(err)),
								);
						const cell: SelectedCell = {
							dwellingType: "lineage",
							bedrooms: sel.pattern,
							sourceClass: "observed",
							codes: sel.polygons,
						};
						if (s.tier === "sal") setSalSelected(cell);
						else setLgaSelected(cell);
					};
					return (
						<div key={s.tier} className="space-y-2">
							<TierBlock
								summary={s}
								selected={selected}
								onCellClick={(slice, sc) => handleCellClick(s.tier, slice, sc)}
							/>
							{selected && (
								<TierPolygonMap
									tier={s.tier}
									geojson={geojsonFor(s.tier)}
									selectedCodes={selected.codes}
									cellLabel={cellLabel(selected)}
								/>
							)}
							<LineagePanel
								tier={s.tier}
								sliceLineages={s.tier === "sal" ? salLineages : lgaLineages}
								onSelectPolygons={handleLineagePick}
							/>
							<PolygonLineageDrilldown
								tier={s.tier}
								sliceLineages={s.tier === "sal" ? salLineages : lgaLineages}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
};
