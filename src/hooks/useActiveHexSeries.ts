import { useCallback, useEffect, useState } from "react";
import { RENTAL_HEX_SERIES_BY_ID } from "@/lib/rental-hex-series";

// Persistent selection of which rental/sales series feeds the HexagonLayer.
// Stored in sessionStorage so a refresh keeps the user's choice within a
// tab, but two tabs can preview different series side-by-side. Same
// pattern as useLayerVisibility — bump the key suffix if the storage
// shape ever changes.

const STORAGE_KEY = "hts:active-hex-series:v1";

const readStored = (): string | null => {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		// Validate the stored id still corresponds to a known series. A
		// schema/series-list change between sessions would otherwise pin
		// us to a now-dangling id; falling back to null lets the picker
		// reset to its default on next read.
		return RENTAL_HEX_SERIES_BY_ID.has(raw) ? raw : null;
	} catch (e) {
		console.warn("active-hex-series: sessionStorage read failed", e);
		return null;
	}
};

const writeStored = (id: string | null): void => {
	try {
		if (id === null) {
			window.sessionStorage.removeItem(STORAGE_KEY);
		} else {
			window.sessionStorage.setItem(STORAGE_KEY, id);
		}
	} catch (e) {
		console.warn("active-hex-series: sessionStorage write failed", e);
	}
};

export const useActiveHexSeries = () => {
	const [activeId, setActiveId] = useState<string | null>(() => readStored());

	useEffect(() => {
		writeStored(activeId);
	}, [activeId]);

	const select = useCallback((id: string | null) => {
		setActiveId(id);
	}, []);

	return { activeId, select };
};
