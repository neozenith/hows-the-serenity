import { useCallback, useState } from "react";
import {
	INITIAL_VISIBILITY,
	type LayerKey,
	type LayerVisibility,
} from "@/lib/layers";

export const useLayerVisibility = () => {
	const [visible, setVisible] = useState<LayerVisibility>(INITIAL_VISIBILITY);
	const toggle = useCallback((key: LayerKey) => {
		setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
	}, []);
	return { visible, toggle };
};
