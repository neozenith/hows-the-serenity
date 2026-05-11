import { useCallback, useEffect, useState } from "react";
import {
	INITIAL_VISIBILITY,
	type LayerKey,
	type LayerVisibility,
} from "@/lib/layers";

// SessionStorage persistence for layer visibility. SessionStorage (not local)
// is deliberate: each tab keeps its own state — so two browser windows can
// experiment with different layer combinations independently — but a full
// refresh inside a tab keeps the user's last toggle layout.
//
// Bump the `:v1` suffix to invalidate every previously-stored payload when
// LayerKey changes shape (renamed/removed keys). Additive changes — a new
// layer key — don't need a bump: the merge-against-defaults read path picks
// up the new key's default automatically.
const STORAGE_KEY = "hts:layer-visibility:v1";

const readStored = (defaults: LayerVisibility): LayerVisibility => {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return defaults;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return defaults;
		const stored = parsed as Record<string, unknown>;
		// Merge: stored booleans win for known keys; unknown keys are dropped;
		// missing keys inherit the default. This forward-compat strategy means
		// adding a new layer doesn't require a storage-key bump.
		const merged: LayerVisibility = { ...defaults };
		for (const k of Object.keys(defaults) as LayerKey[]) {
			const v = stored[k];
			if (typeof v === "boolean") merged[k] = v;
		}
		return merged;
	} catch (e) {
		// sessionStorage can throw on access in private-mode browsers or
		// sandboxed contexts. Persistence is a UX nicety, not a correctness
		// requirement, so we warn and fall back to defaults.
		console.warn("layer-visibility: sessionStorage read failed", e);
		return defaults;
	}
};

const writeStored = (state: LayerVisibility): void => {
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch (e) {
		console.warn("layer-visibility: sessionStorage write failed", e);
	}
};

export const useLayerVisibility = () => {
	// Lazy initialiser: function form runs once on mount, so we read storage
	// exactly once rather than on every re-render.
	const [visible, setVisible] = useState<LayerVisibility>(() =>
		readStored(INITIAL_VISIBILITY),
	);

	// Persist on every state change. Effect (not callback) means *any* future
	// mutator — reset, load-preset, undo/redo — gets persistence for free.
	useEffect(() => {
		writeStored(visible);
	}, [visible]);

	const toggle = useCallback((key: LayerKey) => {
		setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
	}, []);

	// Manual escape hatch: clears the persisted preference and snaps
	// in-memory state back to whatever INITIAL_VISIBILITY currently is.
	// removeItem covers the "already at defaults" path where setVisible would
	// be a no-op and the auto-persist effect wouldn't re-fire.
	const reset = useCallback(() => {
		try {
			window.sessionStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			console.warn("layer-visibility: sessionStorage clear failed", e);
		}
		setVisible(INITIAL_VISIBILITY);
	}, []);

	return { visible, toggle, reset };
};
