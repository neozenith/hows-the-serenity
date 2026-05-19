// Segmented control that drives the `?sources=…` URL parameter. Two
// mount sites share this:
//
//   • RegionDualPlot (/explore/{sal,lga}/:id)     — `size="md"` toolbar
//     above the three stacked panels. Analyst surface; can spare the
//     vertical pixels.
//
//   • SuburbPlotPanel  (the map overlay at `/`)   — `size="sm"` chips
//     mounted in the floating panel header alongside the close button.
//     Real estate is tight (max-width 900px, fixed Plotly height), so
//     this variant uses smaller chips + a shorter "Source" label.
//
// Both surfaces read/write the SAME URL param. Because the entire app
// is wrapped in one <BrowserRouter>, the selection is sticky across
// route changes — a user setting "Observed + Forecast" on the map and
// then clicking through to /explore lands with the same filter active.
//
// `useSourceFilter()` is the small hook that pairs with the chip
// component. It parses the current `?sources=` (default "all"), and
// returns a setter that preserves every other search param so toggling
// source doesn't clobber e.g. the picker's `?sort=` state.

import { useSearchParams } from "react-router-dom";

import {
	DEFAULT_SOURCE_FILTER,
	parseSourceFilter,
	SOURCE_FILTER_LABELS,
	SOURCE_FILTER_PARAM,
	SOURCE_FILTERS,
	type SourceFilter,
} from "@/lib/source-filter";

export type SourceFilterChipsSize = "sm" | "md";

type Props = {
	filter: SourceFilter;
	onChange: (next: SourceFilter) => void;
	size?: SourceFilterChipsSize;
	// Optional label override; pass `null` to hide the label entirely
	// (useful inside dense headers). Defaults to "Source".
	label?: string | null;
	// Lets the parent prefix the data-testid namespace so two co-mounted
	// chip groups (e.g. map + side-by-side analyst panel during a future
	// split view) don't share a selector. Defaults to "source-filter".
	testIdPrefix?: string;
	// Optional extra wrapper classes (e.g. positioning into a flex row).
	className?: string;
};

// Tailwind class fragments per size. Centralised so the two variants
// can't drift accidentally — a future "third density" (e.g. an even
// tinier sparkline tooltip variant) becomes a single map entry, not
// a parallel JSX block.
const SIZE_CLASSES: Readonly<
	Record<SourceFilterChipsSize, { wrap: string; chip: string; label: string }>
> = {
	md: {
		wrap: "gap-2 rounded-md border border-neutral-200 bg-white p-2 text-xs shadow-sm dark:border-neutral-800 dark:bg-neutral-900",
		chip: "rounded-md px-2.5 py-1",
		label:
			"px-1 font-medium text-neutral-500 text-[11px] uppercase tracking-wide dark:text-neutral-400",
	},
	sm: {
		// No border / shadow / background — the chips inherit the parent
		// panel's translucent surface so the toolbar reads as part of the
		// header, not a second slab competing for attention.
		wrap: "gap-1 text-[11px]",
		chip: "rounded px-1.5 py-0.5",
		label:
			"px-0.5 font-medium text-neutral-500 text-[10px] uppercase tracking-wide dark:text-neutral-400",
	},
};

export const SourceFilterChips = ({
	filter,
	onChange,
	size = "md",
	label = "Source",
	testIdPrefix = "source-filter",
	className,
}: Props) => {
	const klass = SIZE_CLASSES[size];
	return (
		<div
			data-testid={`${testIdPrefix}-toolbar`}
			data-size={size}
			className={["flex flex-wrap items-center", klass.wrap, className ?? ""]
				.filter(Boolean)
				.join(" ")}
			role="radiogroup"
			aria-label="Source data filter"
		>
			{label !== null && <span className={klass.label}>{label}</span>}
			{SOURCE_FILTERS.map((f) => {
				const active = filter === f;
				return (
					// biome-ignore lint/a11y/useSemanticElements: chip-style segmented control — wrapping <div role="radiogroup"> + role="radio" on each button is the standard accessible pattern for visually stylable mutually-exclusive toggles. <input type="radio"> would defeat the chip styling without changing screen-reader behaviour.
					<button
						type="button"
						key={f}
						role="radio"
						aria-checked={active}
						data-testid={`${testIdPrefix}-${f}`}
						data-active={active ? "true" : "false"}
						onClick={() => onChange(f)}
						className={[
							klass.chip,
							"transition-colors",
							active
								? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
								: "cursor-pointer text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
						].join(" ")}
					>
						{SOURCE_FILTER_LABELS[f]}
					</button>
				);
			})}
		</div>
	);
};

// Tiny hook that pairs the chip group with router state. Returns a
// `[filter, setFilter]` tuple matching React's useState convention.
// The setter always uses `replace: true` so flipping chips doesn't
// pollute the browser history with one entry per click.
export const useSourceFilter = (): readonly [
	SourceFilter,
	(next: SourceFilter) => void,
] => {
	const [searchParams, setSearchParams] = useSearchParams();
	const filter = parseSourceFilter(searchParams.get(SOURCE_FILTER_PARAM));
	const setFilter = (next: SourceFilter) => {
		const sp = new URLSearchParams(searchParams);
		// Default value is omitted from the URL so a canonical link stays
		// clean. Only non-default values round-trip through `?sources=`.
		if (next === DEFAULT_SOURCE_FILTER) {
			sp.delete(SOURCE_FILTER_PARAM);
		} else {
			sp.set(SOURCE_FILTER_PARAM, next);
		}
		setSearchParams(sp, { replace: true });
	};
	return [filter, setFilter] as const;
};
