// Secondary side panel on each /explore page — the in-kind region picker.
// Renders one row per (code, name) entry as a router <Link>, with a search
// input filtering by name or code substring. Collapsible; collapse state
// persists to localStorage so the analyst's workspace shape survives
// across reloads.
//
// Replaces the previous header `<input list>` + `<datalist>` combobox.
// That widget was native HTML autocomplete but offered no overview — you
// had to KNOW what to type. This one shows every available region in a
// vertical scrollable list, with the current selection highlighted, so
// browsing siblings is one glance away.
//
// The full options array comes from RegionExplorer (already sorted and
// pre-filtered to the observed-data set), so this component stays
// presentation-only: search filter, sort-toggle dispatch, render,
// click → navigate.
//
// Sort mode (alpha | geo) is owned by RegionExplorer and reflected in
// the `?sort=` URL param. The picker only renders the toggle and
// forwards clicks via `onSortModeChange`. When sort=geo each row gets a
// "X km" badge built from the RankedOption.distanceKm provided by the
// parent — the picker never recomputes distances itself.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
	formatDistanceKm,
	type RankedOption,
	type SortMode,
} from "@/lib/region-distance";
import type { RegionKind } from "@/lib/rental-sales-query";

export type RegionPickerOption = { code: string; name: string };

type Props = {
	kind: RegionKind;
	options: ReadonlyArray<RankedOption<RegionPickerOption>>;
	selectedCode: string;
	sortMode: SortMode;
	onSortModeChange: (next: SortMode) => void;
	// True once the centroid file has loaded for this kind. Until then
	// geo mode silently behaves as alpha (sortOptions falls back), so we
	// disable the geo button to avoid pretending the click did something.
	geoSortAvailable: boolean;
};

const STORAGE_KEY = "hts:region-picker-collapsed";

const readCollapsed = (): boolean => {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
};

// Tiny segmented control for the sort toggle. Lives inline in the
// picker header (only when expanded). Default mode (geo) is the active
// state when the URL has no `?sort=` param.
const SortToggle = ({
	mode,
	onChange,
	geoSortAvailable,
}: {
	mode: SortMode;
	onChange: (next: SortMode) => void;
	geoSortAvailable: boolean;
}) => {
	const Button = ({
		target,
		label,
		hint,
		disabled = false,
	}: {
		target: SortMode;
		label: string;
		hint: string;
		disabled?: boolean;
	}) => {
		const active = mode === target;
		return (
			// biome-ignore lint/a11y/useSemanticElements: chip-style segmented control — buttons live inside role="radiogroup", the standard accessible pattern for visually stylable mutually-exclusive toggles. Switching to <input type="radio"> would defeat the chip styling without changing screen-reader behaviour.
			<button
				type="button"
				role="radio"
				aria-checked={active}
				aria-label={hint}
				title={hint}
				data-testid={`region-picker-sort-${target}`}
				data-active={active ? "true" : "false"}
				disabled={disabled}
				onClick={() => !disabled && !active && onChange(target)}
				className={[
					"rounded px-1.5 py-0.5 text-[11px] transition-colors",
					active
						? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
						: disabled
							? "cursor-not-allowed text-neutral-400 dark:text-neutral-600"
							: "cursor-pointer text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
				].join(" ")}
			>
				{label}
			</button>
		);
	};
	return (
		<div
			role="radiogroup"
			aria-label="Region picker sort order"
			className="flex items-center gap-1"
			data-testid="region-picker-sort"
		>
			<Button target="alpha" label="A–Z" hint="Sort alphabetically" />
			<Button
				target="geo"
				label="Geo"
				hint={
					geoSortAvailable
						? "Sort by distance from Melbourne CBD"
						: "Sort by distance (loading centroids…)"
				}
				disabled={!geoSortAvailable}
			/>
		</div>
	);
};

export const RegionPicker = ({
	kind,
	options,
	selectedCode,
	sortMode,
	onSortModeChange,
	geoSortAvailable,
}: Props) => {
	const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
	const [search, setSearch] = useState<string>("");

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
		} catch {
			/* best-effort */
		}
	}, [collapsed]);

	const routePrefix = kind === "suburb" ? "/explore/sal/" : "/explore/lga/";
	const label = kind === "suburb" ? "SAL" : "LGA";

	const q = search.trim().toLowerCase();
	const filtered =
		q === ""
			? options
			: options.filter(
					(o) =>
						o.name.toLowerCase().includes(q) ||
						o.code.toLowerCase().includes(q),
				);

	return (
		<aside
			data-testid="region-picker"
			data-collapsed={collapsed ? "true" : "false"}
			data-sort-mode={sortMode}
			className={[
				"flex shrink-0 flex-col gap-2 border-neutral-200 border-r bg-white p-2 transition-[width] duration-150",
				"dark:border-neutral-800 dark:bg-neutral-950",
				collapsed ? "w-12" : "w-72",
			].join(" ")}
		>
			<div className="flex items-center justify-between gap-2">
				{!collapsed && (
					<h2 className="px-1 font-medium text-neutral-500 text-xs uppercase tracking-wide dark:text-neutral-400">
						{label}s ({options.length.toLocaleString()})
					</h2>
				)}
				{!collapsed && (
					<SortToggle
						mode={sortMode}
						onChange={onSortModeChange}
						geoSortAvailable={geoSortAvailable}
					/>
				)}
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					aria-label={
						collapsed ? "Expand region picker" : "Collapse region picker"
					}
					aria-expanded={!collapsed}
					title={collapsed ? "Expand" : "Collapse"}
					data-testid="region-picker-toggle"
					className="ml-auto rounded px-1.5 py-0.5 text-neutral-500 text-sm hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
				>
					{collapsed ? "›" : "‹"}
				</button>
			</div>

			{!collapsed && (
				<>
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={`Search ${options.length.toLocaleString()} ${label}s…`}
						className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
						data-testid="region-picker-search"
					/>
					<ul
						// min-h-0 lets `flex-1` actually shrink the list below its
						// intrinsic content height (760 SAL items would otherwise
						// blow past the viewport because flex children default to
						// min-height: auto). With it, the list takes the remaining
						// aside height and overflow-y-auto kicks in.
						className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800"
						data-testid="region-picker-list"
					>
						{filtered.length === 0 ? (
							<li
								className="p-2 text-neutral-500 text-xs"
								data-testid="region-picker-empty"
							>
								No matches
							</li>
						) : (
							filtered.map((o) => {
								const active = o.code === selectedCode;
								// Distance badge appears only in geo mode AND only when
								// we actually have a distance (a region with a missing
								// centroid lands at Infinity and prints "").
								const distanceLabel =
									sortMode === "geo" && Number.isFinite(o.distanceKm)
										? formatDistanceKm(o.distanceKm)
										: "";
								return (
									<li key={o.code}>
										<Link
											to={`${routePrefix}${o.code}`}
											data-testid="region-picker-item"
											data-code={o.code}
											data-distance-km={
												Number.isFinite(o.distanceKm)
													? o.distanceKm.toFixed(3)
													: ""
											}
											aria-current={active ? "page" : undefined}
											className={[
												"flex items-center justify-between gap-2 px-2 py-1 text-sm",
												active
													? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
													: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
											].join(" ")}
										>
											<span className="truncate">{o.name}</span>
											<span
												className={
													active
														? "text-neutral-300 text-xs dark:text-neutral-700"
														: "text-neutral-400 text-xs dark:text-neutral-600"
												}
											>
												{distanceLabel
													? `${distanceLabel} · ${o.code}`
													: o.code}
											</span>
										</Link>
									</li>
								);
							})
						)}
					</ul>
				</>
			)}
		</aside>
	);
};
