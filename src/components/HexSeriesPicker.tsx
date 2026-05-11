import { useMemo } from "react";
import type { RentalSeriesValues } from "@/hooks/useLatestRentalSeries";
import {
	type DataType,
	RENTAL_HEX_SERIES,
	RENTAL_HEX_SERIES_BY_ID,
	type RegionTier,
	type RentalHexSeries,
} from "@/lib/rental-hex-series";
import { overlayThemeClass, useOverlayTheme } from "@/lib/theme";

// Top-center floating overlay with three cascading dropdowns:
//   data type → dwelling type → bedrooms
//
// Cascading means changing an upstream selection auto-snaps the downstream
// ones to the *first valid* combination, so the user never sees a dead
// selection. The fourth implicit dimension — region tier (suburb vs LGA) —
// is locked to "suburb" for now: rental publishes both tiers but suburb
// is the higher-resolution view; sales only publishes suburb. The LGA
// data is on disk and ready, just unsurfaced in this v1 picker.
const DEFAULT_TIER: RegionTier = "suburb";

const DATA_TYPE_LABEL: Record<DataType, string> = {
	rental: "Rental",
	sales: "Sales",
};
const DWELLING_LABEL: Record<string, string> = {
	house: "House",
	unit: "Unit",
	vacant_land: "Vacant",
	all: "All",
};
const BEDROOMS_LABEL: Record<string, string> = {
	"0": "0",
	"1": "1",
	"2": "2",
	"3": "3",
	"4": "4",
	all: "All",
};

// Resolve the picker's three-axis selection to an actual series id, or
// null when no series matches. Used both for the initial active->axes
// projection and for cascading auto-snaps.
const findSeries = (
	dataType: DataType,
	dwellingType: string,
	bedrooms: string,
	regionTier: RegionTier = DEFAULT_TIER,
): RentalHexSeries | undefined =>
	RENTAL_HEX_SERIES.find(
		(s) =>
			s.dataType === dataType &&
			s.dwellingType === dwellingType &&
			s.bedrooms === bedrooms &&
			s.regionTier === regionTier,
	);

// First valid series under a partial axes selection — used when an upstream
// change orphans the downstream picks.
const firstSeriesFor = (
	dataType: DataType,
	dwellingType?: string,
): RentalHexSeries | undefined =>
	RENTAL_HEX_SERIES.find(
		(s) =>
			s.dataType === dataType &&
			s.regionTier === DEFAULT_TIER &&
			(dwellingType === undefined || s.dwellingType === dwellingType),
	);

// Slider granularity — 200 steps across the full series value range gives
// the user fine-grained control without flooding `onValueFilterChange`
// with sub-dollar updates. For rental series ($200..$2000) that's $9/step;
// for sales ($200k..$3M) that's $14k/step.
const SLIDER_STEPS = 200;

const formatRangeValue = (value: number, dataType: DataType): string => {
	const v = Math.round(value).toLocaleString("en-AU");
	return dataType === "rental" ? `$${v}/wk` : `$${v}`;
};

export const HexSeriesPicker = ({
	activeId,
	onSelect,
	activeSeriesValues,
	valueFilter,
	onValueFilterChange,
}: {
	activeId: string | null;
	onSelect: (id: string | null) => void;
	activeSeriesValues: RentalSeriesValues | null;
	valueFilter: readonly [number, number] | null;
	onValueFilterChange: (range: readonly [number, number] | null) => void;
}) => {
	const { theme } = useOverlayTheme();

	const active = activeId
		? (RENTAL_HEX_SERIES_BY_ID.get(activeId) ?? null)
		: null;
	const dataType: DataType | null = active?.dataType ?? null;
	const dwellingType: string | null = active?.dwellingType ?? null;
	const bedrooms: string | null = active?.bedrooms ?? null;

	// Available options per dimension under the current parent selection.
	// Memoised against the actual selection values rather than the active
	// series object so a same-shape series reload doesn't churn the menu.
	const dwellingOptions = useMemo(() => {
		if (!dataType) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const s of RENTAL_HEX_SERIES) {
			if (s.dataType !== dataType || s.regionTier !== DEFAULT_TIER) continue;
			if (seen.has(s.dwellingType)) continue;
			seen.add(s.dwellingType);
			out.push(s.dwellingType);
		}
		return out;
	}, [dataType]);

	const bedroomOptions = useMemo(() => {
		if (!dataType || !dwellingType) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const s of RENTAL_HEX_SERIES) {
			if (
				s.dataType !== dataType ||
				s.dwellingType !== dwellingType ||
				s.regionTier !== DEFAULT_TIER
			)
				continue;
			if (seen.has(s.bedrooms)) continue;
			seen.add(s.bedrooms);
			out.push(s.bedrooms);
		}
		return out;
	}, [dataType, dwellingType]);

	// Cascading change handlers — each level resets its downstream picks
	// to the first valid combination under the new selection.
	const handleDataType = (raw: string) => {
		if (raw === "") {
			onSelect(null);
			return;
		}
		const next = raw as DataType;
		const first = firstSeriesFor(next);
		onSelect(first?.id ?? null);
	};

	const handleDwelling = (raw: string) => {
		if (!dataType) return;
		const first = firstSeriesFor(dataType, raw);
		onSelect(first?.id ?? null);
	};

	const handleBedrooms = (raw: string) => {
		if (!dataType || !dwellingType) return;
		const found = findSeries(dataType, dwellingType, raw);
		onSelect(found?.id ?? null);
	};

	const selectClass =
		"cursor-pointer rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";

	// Derive slider state. When there's no filter (null), default the
	// thumbs to the series' full extent. When the user has set a filter,
	// reflect those values. The slider always operates on the series'
	// natural min..max range — the filter just clamps within it.
	const sliderMin = activeSeriesValues?.valueMin ?? 0;
	const sliderMax = activeSeriesValues?.valueMax ?? 0;
	const sliderStep =
		sliderMax > sliderMin ? (sliderMax - sliderMin) / SLIDER_STEPS : 1;
	const filterLo = valueFilter ? valueFilter[0] : sliderMin;
	const filterHi = valueFilter ? valueFilter[1] : sliderMax;
	const sliderActive =
		dataType !== null &&
		activeSeriesValues !== null &&
		activeSeriesValues.byCode.size > 0 &&
		sliderMax > sliderMin;

	const handleLow = (raw: string) => {
		if (!activeSeriesValues) return;
		const v = Math.min(Number(raw), filterHi);
		// Snap back to "no filter" if the user dragged both thumbs to the
		// natural extents — keeps storage clean and avoids confusing the
		// frontend's "is anything filtered out?" question.
		if (v === sliderMin && filterHi === sliderMax) {
			onValueFilterChange(null);
		} else {
			onValueFilterChange([v, filterHi]);
		}
	};

	const handleHigh = (raw: string) => {
		if (!activeSeriesValues) return;
		const v = Math.max(Number(raw), filterLo);
		if (filterLo === sliderMin && v === sliderMax) {
			onValueFilterChange(null);
		} else {
			onValueFilterChange([filterLo, v]);
		}
	};

	return (
		<div
			className={[
				"absolute top-4 left-1/2 z-10 -translate-x-1/2",
				"flex flex-col gap-2",
				"rounded-md px-3 py-2 text-xs shadow-md backdrop-blur",
				"bg-white/95 dark:bg-neutral-900/90",
				overlayThemeClass(theme),
			].join(" ")}
		>
			<div className="flex items-center gap-2">
				<span className="text-neutral-500 dark:text-neutral-400">
					Hex view:
				</span>
				<select
					aria-label="Data type"
					value={dataType ?? ""}
					onChange={(e) => handleDataType(e.target.value)}
					className={selectClass}
				>
					<option value="">— pick —</option>
					<option value="rental">{DATA_TYPE_LABEL.rental}</option>
					<option value="sales">{DATA_TYPE_LABEL.sales}</option>
				</select>
				<select
					aria-label="Dwelling type"
					value={dwellingType ?? ""}
					onChange={(e) => handleDwelling(e.target.value)}
					disabled={dwellingOptions.length === 0}
					className={selectClass}
				>
					{dwellingOptions.length === 0 ? (
						<option value="">—</option>
					) : (
						dwellingOptions.map((d) => (
							<option key={d} value={d}>
								{DWELLING_LABEL[d] ?? d}
							</option>
						))
					)}
				</select>
				<select
					aria-label="Bedrooms"
					value={bedrooms ?? ""}
					onChange={(e) => handleBedrooms(e.target.value)}
					disabled={bedroomOptions.length === 0}
					className={selectClass}
				>
					{bedroomOptions.length === 0 ? (
						<option value="">—</option>
					) : (
						bedroomOptions.map((b) => (
							<option key={b} value={b}>
								{BEDROOMS_LABEL[b] ?? b}
							</option>
						))
					)}
				</select>
				{activeId !== null && (
					<button
						type="button"
						onClick={() => onSelect(null)}
						aria-label="Clear hex selection"
						title="Clear"
						className="cursor-pointer rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
					>
						×
					</button>
				)}
			</div>
			{/* Value-range row. Two stacked range inputs share the series' full
		    [min, max] domain. Hidden until a series is picked + values are
		    loaded; once visible, each thumb controls its end of the range
		    and "snap back to null" engages when both thumbs are at the
		    extremes. */}
			{sliderActive && dataType && (
				<div className="flex flex-col gap-1 border-t border-neutral-200 pt-2 dark:border-neutral-700">
					<div className="flex items-center justify-between text-neutral-600 dark:text-neutral-400">
						<span>Value range</span>
						{valueFilter !== null && (
							<button
								type="button"
								onClick={() => onValueFilterChange(null)}
								className="cursor-pointer rounded px-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
							>
								reset
							</button>
						)}
					</div>
					<label className="flex items-center gap-2">
						<span className="w-8 text-neutral-500 dark:text-neutral-400">
							min
						</span>
						<input
							type="range"
							min={sliderMin}
							max={sliderMax}
							step={sliderStep}
							value={filterLo}
							onChange={(e) => handleLow(e.target.value)}
							aria-label="Minimum value"
							className="flex-1 cursor-pointer accent-neutral-700 dark:accent-neutral-300"
						/>
						<span className="w-20 text-right tabular-nums text-neutral-900 dark:text-neutral-100">
							{formatRangeValue(filterLo, dataType)}
						</span>
					</label>
					<label className="flex items-center gap-2">
						<span className="w-8 text-neutral-500 dark:text-neutral-400">
							max
						</span>
						<input
							type="range"
							min={sliderMin}
							max={sliderMax}
							step={sliderStep}
							value={filterHi}
							onChange={(e) => handleHigh(e.target.value)}
							aria-label="Maximum value"
							className="flex-1 cursor-pointer accent-neutral-700 dark:accent-neutral-300"
						/>
						<span className="w-20 text-right tabular-nums text-neutral-900 dark:text-neutral-100">
							{formatRangeValue(filterHi, dataType)}
						</span>
					</label>
				</div>
			)}
		</div>
	);
};
