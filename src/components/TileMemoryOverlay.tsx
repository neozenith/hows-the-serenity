import { useEffect, useRef, useState } from "react";
import {
	getTileStatsSnapshot,
	subscribeTileStats,
	type TileStatsSnapshot,
} from "@/lib/tile-stats";

// Bottom-right debug overlay: cumulative tile-memory line chart filtered to
// the SAL layer only. Updates every tile load/unload event via an imperative
// pipeline (refs + textContent / SVG attribute writes) so this renders zero
// React reconciliation work in the hot path. Per the project's Deck.GL-native
// ADR.
//
// To add other layers later: change CHART_LAYER_ID to the matching layer id
// passed to `tileLifecycle()` in App.tsx, or restore the multi-series chart.

const CHART_LAYER_ID = "suburbs-sal";
const CHART_LAYER_LABEL = "SAL suburbs";
const CHART_LAYER_COLOR = "rgb(200 200 50)"; // matches App.tsx SAL stroke
const CHART_W = 240;
const CHART_H = 80;

const FORMAT_MB = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`;

export const TileMemoryOverlay = () => {
	const [collapsed, setCollapsed] = useState(false);
	const totalBytesRef = useRef<HTMLSpanElement | null>(null);
	const tileCountRef = useRef<HTMLSpanElement | null>(null);
	const peakRef = useRef<HTMLSpanElement | null>(null);
	const polylineRef = useRef<SVGPolylineElement | null>(null);
	const peakBytes = useRef(0);

	useEffect(() => {
		const apply = (snap: TileStatsSnapshot) => {
			const layer = snap.byLayer.find((l) => l.layerId === CHART_LAYER_ID);
			const totalBytes = layer?.totalBytes ?? 0;
			const tileCount = layer?.tileCount ?? 0;
			const series = layer?.series ?? [];

			if (totalBytesRef.current) totalBytesRef.current.textContent = FORMAT_MB(totalBytes);
			if (tileCountRef.current) tileCountRef.current.textContent = String(tileCount);
			if (totalBytes > peakBytes.current) {
				peakBytes.current = totalBytes;
				if (peakRef.current) peakRef.current.textContent = FORMAT_MB(peakBytes.current);
			}

			if (!polylineRef.current) return;
			if (series.length === 0) {
				polylineRef.current.setAttribute("points", "");
				return;
			}
			// Re-scale per-frame: x to the layer's first event onward (so the
			// plot fills the panel even before other layers chime in), y to
			// this layer's own peak.
			const firstTs = series[0]?.ts ?? snap.startedAt;
			const lastTs = series[series.length - 1]?.ts ?? firstTs;
			const tSpan = Math.max(lastTs - firstTs, 1);
			let maxBytes = 1;
			for (const p of series) {
				if (p.cumulativeBytes > maxBytes) maxBytes = p.cumulativeBytes;
			}
			const pts = series
				.map((p) => {
					const x = ((p.ts - firstTs) / tSpan) * CHART_W;
					const y = CHART_H - (p.cumulativeBytes / maxBytes) * CHART_H;
					return `${x.toFixed(1)},${y.toFixed(1)}`;
				})
				.join(" ");
			polylineRef.current.setAttribute("points", pts);
		};
		apply(getTileStatsSnapshot());
		return subscribeTileStats((_event, snap) => apply(snap));
	}, []);

	return (
		<aside
			className={`absolute right-4 bottom-4 z-10 ${
				collapsed ? "w-auto" : "w-64"
			} rounded-md bg-white/95 px-3 py-2 text-xs shadow-md backdrop-blur`}
		>
			<header className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<span
						className="inline-block h-2 w-2 rounded-sm"
						style={{ background: CHART_LAYER_COLOR }}
						aria-hidden="true"
					/>
					<h2 className="font-semibold text-neutral-900">
						Tile memory · {CHART_LAYER_LABEL}
					</h2>
				</div>
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					aria-expanded={!collapsed}
					aria-label={collapsed ? "Show tile-memory overlay" : "Hide tile-memory overlay"}
					className="cursor-pointer rounded px-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
				>
					<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
				</button>
			</header>
			{!collapsed && (
				<div className="mt-1.5 space-y-1.5">
					<dl className="grid grid-cols-3 gap-1 text-[10px] text-neutral-600">
						<div>
							<dt className="text-neutral-500">tiles</dt>
							<dd>
								<span ref={tileCountRef} className="tabular-nums text-neutral-900">
									0
								</span>
							</dd>
						</div>
						<div>
							<dt className="text-neutral-500">live</dt>
							<dd>
								<span ref={totalBytesRef} className="tabular-nums text-neutral-900">
									0.00 MB
								</span>
							</dd>
						</div>
						<div>
							<dt className="text-neutral-500">peak</dt>
							<dd>
								<span ref={peakRef} className="tabular-nums text-neutral-900">
									0.00 MB
								</span>
							</dd>
						</div>
					</dl>
					<svg
						viewBox={`0 0 ${CHART_W} ${CHART_H}`}
						preserveAspectRatio="none"
						className="block h-20 w-full rounded bg-neutral-100"
						aria-label={`Cumulative ${CHART_LAYER_LABEL} tile memory over time`}
					>
						<polyline
							ref={polylineRef}
							points=""
							fill="none"
							stroke={CHART_LAYER_COLOR}
							strokeWidth="1.5"
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				</div>
			)}
		</aside>
	);
};
