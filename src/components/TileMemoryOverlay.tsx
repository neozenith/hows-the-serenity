import { useEffect, useRef, useState } from "react";
import {
	getTileStatsSnapshot,
	subscribeTileStats,
	type TileStatsSnapshot,
} from "@/lib/tile-stats";

// Bottom-right debug overlay: live cumulative tile-memory line chart plus
// running count + MB readout. Updates every tile load/unload event via an
// imperative pipeline (refs + textContent / SVG attribute writes) so this
// renders zero React reconciliation work in the hot path. Per the project's
// Deck.GL-native ADR.

const CHART_W = 220;
const CHART_H = 60;
const FORMAT_MB = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`;

const polylinePoints = (snap: TileStatsSnapshot): string => {
	const { series, startedAt } = snap;
	if (series.length === 0) return "";
	const lastTs = series[series.length - 1]?.ts ?? startedAt;
	const tSpan = Math.max(lastTs - startedAt, 1);
	const maxBytes = Math.max(...series.map((p) => p.cumulativeBytes), 1);
	return series
		.map((p) => {
			const x = ((p.ts - startedAt) / tSpan) * CHART_W;
			const y = CHART_H - (p.cumulativeBytes / maxBytes) * CHART_H;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
};

export const TileMemoryOverlay = () => {
	const [collapsed, setCollapsed] = useState(false);
	const totalBytesRef = useRef<HTMLSpanElement | null>(null);
	const tileCountRef = useRef<HTMLSpanElement | null>(null);
	const polylineRef = useRef<SVGPolylineElement | null>(null);
	const peakRef = useRef<HTMLSpanElement | null>(null);
	const peakBytes = useRef(0);

	// Render initial snapshot on mount, then keep DOM in sync via the
	// subscription. The subscription fires synchronously on each tile event,
	// so updates are tile-event-paced (typically 50-100/sec during a pan).
	useEffect(() => {
		const apply = (snap: TileStatsSnapshot) => {
			if (totalBytesRef.current) {
				totalBytesRef.current.textContent = FORMAT_MB(snap.totalBytes);
			}
			if (tileCountRef.current) {
				tileCountRef.current.textContent = String(snap.tileCount);
			}
			if (snap.totalBytes > peakBytes.current) {
				peakBytes.current = snap.totalBytes;
				if (peakRef.current) peakRef.current.textContent = FORMAT_MB(peakBytes.current);
			}
			if (polylineRef.current) {
				polylineRef.current.setAttribute("points", polylinePoints(snap));
			}
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
				<h2 className="font-semibold text-neutral-900">Tile memory</h2>
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
						className="block h-12 w-full rounded bg-neutral-100"
						aria-label="Cumulative tile memory over time"
					>
						<polyline
							ref={polylineRef}
							points=""
							fill="none"
							stroke="rgb(80 220 130)"
							strokeWidth="1.5"
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				</div>
			)}
		</aside>
	);
};
