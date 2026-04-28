import { useEffect, useState } from "react";
import type { RegionSelection } from "@/lib/region";
import { installRegionSelectTestHook } from "@/lib/test-hooks";

// Selected region (suburb/LGA) for the SuburbPlotPanel. Also wires up the
// `__htsSelectRegion` window hook so e2e tests can drive selection without
// going through deck.gl's WebGL picking pipeline (which races the headless
// input event loop). The useState setter has stable identity, so the
// install/cleanup pair runs exactly once.
export const useRegionSelection = () => {
	const [selection, setSelection] = useState<RegionSelection | null>(null);

	useEffect(() => installRegionSelectTestHook(setSelection), []);

	return { selection, setSelection };
};
