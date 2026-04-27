// Frame-rate observability — runs a continuous requestAnimationFrame loop and
// exposes a subscribe API so the debug overlay can show live FPS, frame time,
// and a count of "long frames" (>50ms — the threshold Chrome uses for its
// "[Violation] requestAnimationFrame handler took Nms" warnings).
//
// Same imperative-update contract as tile-stats: subscribers fire on every
// frame and are expected to do textContent / SVG attribute writes — never
// React state in the hot path. Per the project's Deck.GL-native ADR.

export type FrameStats = {
	fps: number; // exponential moving average over recent frames
	frameMs: number; // last frame's delta
	longFrames: number; // count of frames > LONG_FRAME_THRESHOLD_MS since start
	history: ReadonlyArray<number>; // last N frame deltas (ms)
};

type Listener = (stats: FrameStats) => void;

// Public so the overlay can draw a threshold line at the same value Chrome
// uses internally.
export const LONG_FRAME_THRESHOLD_MS = 50;

const HISTORY_SIZE = 120;
const EMA_ALPHA = 0.1;
// Discard impossibly large gaps (page backgrounded / tab switched) so the
// EMA isn't yanked to ~0.5 fps after a 30-second idle.
const MAX_PLAUSIBLE_FRAME_MS = 5000;

const history: number[] = [];
const listeners = new Set<Listener>();
let emaFps = 60;
let longFrameCount = 0;
let lastTs = 0;

const tick = (ts: number) => {
	if (lastTs > 0) {
		const delta = ts - lastTs;
		if (delta > 0 && delta < MAX_PLAUSIBLE_FRAME_MS) {
			emaFps = emaFps * (1 - EMA_ALPHA) + (1000 / delta) * EMA_ALPHA;
			if (delta > LONG_FRAME_THRESHOLD_MS) longFrameCount++;
			history.push(delta);
			if (history.length > HISTORY_SIZE) history.shift();
			const stats: FrameStats = {
				fps: emaFps,
				frameMs: delta,
				longFrames: longFrameCount,
				history,
			};
			for (const fn of listeners) fn(stats);
		}
	}
	lastTs = ts;
	requestAnimationFrame(tick);
};

// Module init — only in the browser. jsdom (used by Vitest) has rAF; node SSR
// builds wouldn't, but this app doesn't SSR.
if (typeof window !== "undefined" && typeof requestAnimationFrame === "function") {
	requestAnimationFrame(tick);
}

export const subscribeFrameStats = (fn: Listener): (() => void) => {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
};

export const getFrameStatsSnapshot = (): FrameStats => ({
	fps: emaFps,
	frameMs: history[history.length - 1] ?? 0,
	longFrames: longFrameCount,
	history,
});
