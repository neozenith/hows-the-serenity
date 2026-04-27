import { useEffect, useRef, useState } from "react";
import {
	type FrameStats,
	getFrameStatsSnapshot,
	LONG_FRAME_THRESHOLD_MS,
	subscribeFrameStats,
} from "@/lib/frame-stats";
import {
	getTileStatsSnapshot,
	subscribeTileStats,
	type TileStatsSnapshot,
} from "@/lib/tile-stats";

// Bottom-right debug overlay. Two stacked panels:
//   1. SAL tile memory (cumulative line chart, live/peak MB, count)
//   2. Frame timing (live FPS, long-frame counter, frame-time sparkline)
// Both update via imperative DOM writes through refs — never React state in
// the hot path. Per the project's Deck.GL-native ADR.

// --- SAL tile-memory chart ---------------------------------------------------
const CHART_LAYER_ID = "suburbs-sal";
const CHART_LAYER_LABEL = "SAL suburbs";
const CHART_LAYER_COLOR = "rgb(200 200 50)"; // matches App.tsx SAL stroke
const TILE_CHART_W = 240;
const TILE_CHART_H = 80;

// --- Frame-time sparkline ----------------------------------------------------
const FRAME_CHART_W = 240;
const FRAME_CHART_H = 50;
// Cap the sparkline y-axis so pathological spikes don't compress the rest of
// the trace into a flat line. Anything taller than this clips at the top.
const FRAME_CHART_CAP_MS = 120;

const FORMAT_MB = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`;

export const TileMemoryOverlay = () => {
	const [collapsed, setCollapsed] = useState(false);

	// Tile-memory refs
	const totalBytesRef = useRef<HTMLSpanElement | null>(null);
	const tileCountRef = useRef<HTMLSpanElement | null>(null);
	const peakBytesRef = useRef<HTMLSpanElement | null>(null);
	const tilePolylineRef = useRef<SVGPolylineElement | null>(null);
	const peakBytesValue = useRef(0);

	// Frame-stats refs
	const fpsRef = useRef<HTMLSpanElement | null>(null);
	const lastFrameRef = useRef<HTMLSpanElement | null>(null);
	const longFramesRef = useRef<HTMLSpanElement | null>(null);
	const framePolylineRef = useRef<SVGPolylineElement | null>(null);

	// Tile-stats subscription
	useEffect(() => {
		const apply = (snap: TileStatsSnapshot) => {
			const layer = snap.byLayer.find((l) => l.layerId === CHART_LAYER_ID);
			const totalBytes = layer?.totalBytes ?? 0;
			const tileCount = layer?.tileCount ?? 0;
			const series = layer?.series ?? [];

			if (totalBytesRef.current) totalBytesRef.current.textContent = FORMAT_MB(totalBytes);
			if (tileCountRef.current) tileCountRef.current.textContent = String(tileCount);
			if (totalBytes > peakBytesValue.current) {
				peakBytesValue.current = totalBytes;
				if (peakBytesRef.current) peakBytesRef.current.textContent = FORMAT_MB(peakBytesValue.current);
			}

			if (!tilePolylineRef.current) return;
			if (series.length === 0) {
				tilePolylineRef.current.setAttribute("points", "");
				return;
			}
			const firstTs = series[0]?.ts ?? snap.startedAt;
			const lastTs = series[series.length - 1]?.ts ?? firstTs;
			const tSpan = Math.max(lastTs - firstTs, 1);
			let maxBytes = 1;
			for (const p of series) {
				if (p.cumulativeBytes > maxBytes) maxBytes = p.cumulativeBytes;
			}
			const pts = series
				.map((p) => {
					const x = ((p.ts - firstTs) / tSpan) * TILE_CHART_W;
					const y = TILE_CHART_H - (p.cumulativeBytes / maxBytes) * TILE_CHART_H;
					return `${x.toFixed(1)},${y.toFixed(1)}`;
				})
				.join(" ");
			tilePolylineRef.current.setAttribute("points", pts);
		};
		apply(getTileStatsSnapshot());
		return subscribeTileStats((_event, snap) => apply(snap));
	}, []);

	// Frame-stats subscription
	useEffect(() => {
		const apply = (stats: FrameStats) => {
			if (fpsRef.current) fpsRef.current.textContent = stats.fps.toFixed(0);
			if (lastFrameRef.current) {
				lastFrameRef.current.textContent = `${stats.frameMs.toFixed(1)} ms`;
			}
			if (longFramesRef.current) {
				longFramesRef.current.textContent = String(stats.longFrames);
			}
			if (!framePolylineRef.current) return;
			const h = stats.history;
			if (h.length === 0) {
				framePolylineRef.current.setAttribute("points", "");
				return;
			}
			const stepX = FRAME_CHART_W / Math.max(h.length - 1, 1);
			const pts = h
				.map((ms, i) => {
					const x = i * stepX;
					const clamped = Math.min(ms, FRAME_CHART_CAP_MS);
					const y = FRAME_CHART_H - (clamped / FRAME_CHART_CAP_MS) * FRAME_CHART_H;
					return `${x.toFixed(1)},${y.toFixed(1)}`;
				})
				.join(" ");
			framePolylineRef.current.setAttribute("points", pts);
		};
		apply(getFrameStatsSnapshot());
		return subscribeFrameStats(apply);
	}, []);

	const longFrameThresholdY =
		FRAME_CHART_H - (LONG_FRAME_THRESHOLD_MS / FRAME_CHART_CAP_MS) * FRAME_CHART_H;

	return (
		<aside
			className={`absolute right-4 bottom-4 z-10 ${
				collapsed ? "w-auto" : "w-64"
			} rounded-md bg-white/95 px-3 py-2 text-xs shadow-md backdrop-blur`}
		>
			<header className="flex items-center justify-between gap-2">
				<h2 className="font-semibold text-neutral-900">Debug</h2>
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					aria-expanded={!collapsed}
					aria-label={collapsed ? "Show debug overlay" : "Hide debug overlay"}
					className="cursor-pointer rounded px-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
				>
					<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
				</button>
			</header>
			{!collapsed && (
				<div className="mt-1.5 space-y-3">
					{/* Tile memory section */}
					<section>
						<h3 className="mb-1 flex items-center gap-1.5 font-semibold text-neutral-700">
							<span
								className="inline-block h-2 w-2 rounded-sm"
								style={{ background: CHART_LAYER_COLOR }}
								aria-hidden="true"
							/>
							Tile memory · {CHART_LAYER_LABEL}
						</h3>
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
									<span ref={peakBytesRef} className="tabular-nums text-neutral-900">
										0.00 MB
									</span>
								</dd>
							</div>
						</dl>
						<svg
							viewBox={`0 0 ${TILE_CHART_W} ${TILE_CHART_H}`}
							preserveAspectRatio="none"
							className="mt-1 block h-20 w-full rounded bg-neutral-100"
							aria-label={`Cumulative ${CHART_LAYER_LABEL} tile memory over time`}
						>
							<polyline
								ref={tilePolylineRef}
								points=""
								fill="none"
								stroke={CHART_LAYER_COLOR}
								strokeWidth="1.5"
								vectorEffect="non-scaling-stroke"
							/>
						</svg>
					</section>

					{/* Frame timing section */}
					<section>
						<h3 className="mb-1 font-semibold text-neutral-700">Frame timing</h3>
						<dl className="grid grid-cols-3 gap-1 text-[10px] text-neutral-600">
							<div>
								<dt className="text-neutral-500">fps</dt>
								<dd>
									<span ref={fpsRef} className="tabular-nums text-neutral-900">
										60
									</span>
								</dd>
							</div>
							<div>
								<dt className="text-neutral-500">last</dt>
								<dd>
									<span ref={lastFrameRef} className="tabular-nums text-neutral-900">
										0.0 ms
									</span>
								</dd>
							</div>
							<div>
								<dt className="text-neutral-500">{">50 ms"}</dt>
								<dd>
									<span ref={longFramesRef} className="tabular-nums text-neutral-900">
										0
									</span>
								</dd>
							</div>
						</dl>
						<svg
							viewBox={`0 0 ${FRAME_CHART_W} ${FRAME_CHART_H}`}
							preserveAspectRatio="none"
							className="mt-1 block h-12 w-full rounded bg-neutral-100"
							aria-label="Frame time over the last 120 frames"
						>
							{/* 50ms threshold — Chrome's rAF-violation line. */}
							<line
								x1="0"
								y1={longFrameThresholdY}
								x2={FRAME_CHART_W}
								y2={longFrameThresholdY}
								stroke="rgb(220 60 60)"
								strokeWidth="0.5"
								strokeDasharray="2 2"
							/>
							<polyline
								ref={framePolylineRef}
								points=""
								fill="none"
								stroke="rgb(60 130 220)"
								strokeWidth="1.25"
								vectorEffect="non-scaling-stroke"
							/>
						</svg>
					</section>
				</div>
			)}
		</aside>
	);
};
