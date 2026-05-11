import { type RefObject, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { DbStatus } from "@/hooks/useDuckDb";
import {
	LAYER_DISPLAY_DEFS,
	type LayerKey,
	type LayerVisibility,
} from "@/lib/layers";
import { overlayThemeClass, useOverlayTheme } from "@/lib/theme";

const DOT_COLOR: Record<DbStatus["state"], string> = {
	loading: "#ffa500",
	ready: "#00c864",
	error: "#ff4444",
};

export const ControlPanel = ({
	status,
	visible,
	onToggle,
	onResetVisibility,
	onSetAllVisibility,
	zoomLabelRef,
	initialZoom,
}: {
	status: DbStatus;
	visible: LayerVisibility;
	onToggle: (key: LayerKey) => void;
	onResetVisibility: () => void;
	onSetAllVisibility: (value: boolean) => void;
	zoomLabelRef: RefObject<HTMLSpanElement | null>;
	initialZoom: number;
}) => {
	// Default collapsed — keeps the map area clear; user expands when needed.
	const [collapsed, setCollapsed] = useState(true);
	const { theme } = useOverlayTheme();
	return (
		<aside
			className={[
				"absolute top-4 left-4 z-10",
				collapsed ? "w-auto" : "w-64",
				"rounded-md px-4 py-3 text-sm shadow-md backdrop-blur",
				"bg-white/95 dark:bg-neutral-900/90",
				overlayThemeClass(theme),
			].join(" ")}
		>
			<header className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span
						className="inline-block h-2 w-2 rounded-full"
						style={{ background: DOT_COLOR[status.state] }}
						aria-hidden="true"
					/>
					<h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
						How's the Serenity?
					</h1>
				</div>
				<div className="flex items-center gap-1.5">
					{/* DOM-updated by the App's onViewStateChange — keeps textContent
					    fresh without round-tripping through React state. */}
					<span
						ref={zoomLabelRef}
						role="status"
						aria-label="Current zoom level"
						className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400"
					>
						z {initialZoom.toFixed(1)}
					</span>
					<ThemeToggle />
					<button
						type="button"
						onClick={() => setCollapsed((c) => !c)}
						aria-expanded={!collapsed}
						aria-label={collapsed ? "Show controls" : "Hide controls"}
						className="cursor-pointer rounded px-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
					>
						<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
					</button>
				</div>
			</header>
			{!collapsed && (
				<div className="mt-2 space-y-3">
					<section>
						<p className="text-neutral-700 dark:text-neutral-300">
							{status.message}
						</p>
						{status.state === "ready" && status.tables.length > 0 && (
							<ul className="mt-1 space-y-0.5 text-xs text-neutral-600 dark:text-neutral-400">
								{status.tables.map((t) => (
									<li key={t.name}>
										<code className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800 dark:text-neutral-200">
											{t.name}
										</code>
										{" · "}
										{t.rows.toLocaleString()} rows
									</li>
								))}
							</ul>
						)}
					</section>
					<hr className="border-neutral-200 dark:border-neutral-700" />
					<section>
						<div className="mb-1.5 flex items-center justify-between gap-2">
							<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
								Layers
							</h2>
							<div className="flex items-center gap-1">
								{/* All off — symmetric counterpart to Reset. Useful when
									you want a clean isolation slate, e.g. for testing one
									layer in isolation, without manually unticking each
									checkbox. State persists to sessionStorage like any
									other change. */}
								<button
									type="button"
									onClick={() => onSetAllVisibility(false)}
									aria-label="Turn off every layer"
									title="All off"
									className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
								>
									All off
								</button>
								{/* Wipes the sessionStorage entry and snaps back to the
									built-in defaults — effectively "all on" given the
									current INITIAL_VISIBILITY (every layer defaults to on
									except tileGrid). */}
								<button
									type="button"
									onClick={onResetVisibility}
									aria-label="Reset layer visibility to defaults"
									title="Reset to defaults"
									className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
								>
									Reset
								</button>
							</div>
						</div>
						<ul className="space-y-1.5">
							{LAYER_DISPLAY_DEFS.map((layer) => (
								<li key={layer.key}>
									<label className="flex cursor-pointer items-center gap-2 text-neutral-700 dark:text-neutral-300">
										<input
											type="checkbox"
											className="h-3.5 w-3.5 cursor-pointer accent-neutral-700 dark:accent-neutral-300"
											checked={visible[layer.key]}
											onChange={() => onToggle(layer.key)}
										/>
										<span className="flex-1">
											<span className="block text-neutral-900 dark:text-neutral-50">
												{layer.label}
											</span>
											<span className="block text-xs text-neutral-500 dark:text-neutral-400">
												{layer.hint}
											</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					</section>
				</div>
			)}
		</aside>
	);
};
