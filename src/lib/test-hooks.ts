import type { RegionSelection } from "./region";
import { getTileStatsSnapshot } from "./tile-stats";

// e2e-only diagnostic surface exposed on `window`. Two hooks:
//
//   __htsTileCount(layerId)  — read-only: current loaded tile count for a
//                              deck.gl layer. Tests poll it before asserting.
//
//   __htsSelectRegion(sel)   — write: opens the plot panel programmatically.
//                              Exists because synthesised clicks against
//                              deck.gl's WebGL canvas don't reliably reach the
//                              picking pipeline in headless Playwright (the
//                              picking framebuffer races the input event loop).
//                              Tests bypass picking; manual users still
//                              exercise the full click path.

declare global {
	interface Window {
		__htsTileCount?: (layerId: string) => number;
		__htsSelectRegion?: (selection: RegionSelection | null) => void;
	}
}

if (typeof window !== "undefined") {
	window.__htsTileCount = (layerId: string) => {
		const snap = getTileStatsSnapshot();
		return snap.byLayer.find((l) => l.layerId === layerId)?.tileCount ?? 0;
	};
}

// Installed/uninstalled from a useEffect inside `useRegionSelection` so the
// React state setter is captured at component scope. Returns the cleanup so
// the caller can `useEffect(() => install(setter), [])` directly.
export const installRegionSelectTestHook = (
	setter: (selection: RegionSelection | null) => void,
): (() => void) => {
	if (typeof window === "undefined") return () => {};
	window.__htsSelectRegion = setter;
	return () => {
		window.__htsSelectRegion = undefined;
	};
};
