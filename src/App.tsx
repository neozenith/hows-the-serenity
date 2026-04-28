import { DeckGL, type MapViewState } from "deck.gl";
import { useMemo, useRef } from "react";
import { Map as BaseMap } from "react-map-gl/maplibre";
import { ControlPanel } from "@/components/ControlPanel";
import { SuburbPlotPanel } from "@/components/SuburbPlotPanel";
import { TileMemoryOverlay } from "@/components/TileMemoryOverlay";
import { useDuckDb } from "@/hooks/useDuckDb";
import { useLayerVisibility } from "@/hooks/useLayerVisibility";
import { useRegionSelection } from "@/hooks/useRegionSelection";
import { useSuburbMappings } from "@/hooks/useSuburbMappings";
import { useTileManifests } from "@/hooks/useTileManifests";
import { buildLayers, pickToTooltip } from "@/lib/layers";
// Side-effect import: installs the read-only `__htsTileCount` accessor on
// `window` at module load. The companion `__htsSelectRegion` write-hook is
// installed inside `useRegionSelection`, where it can capture the React
// state setter.
import "@/lib/test-hooks";

// CartoDB's dark-matter style is a free, no-auth MapLibre style. Matches the
// aesthetic of the predecessor VanillaJS site (see docs/context/history.md).
const MAP_STYLE =
	"https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const INITIAL_VIEW_STATE: MapViewState = {
	longitude: 144.9631,
	latitude: -37.8136,
	zoom: 9,
	pitch: 0,
	bearing: 0,
};

const App = () => {
	const status = useDuckDb();
	const manifests = useTileManifests();
	const { visible, toggle } = useLayerVisibility();
	const { selection, setSelection } = useRegionSelection();
	useSuburbMappings();

	// Live zoom label — imperative DOM update via this ref so the panel header
	// can show the current zoom without lifting Deck.GL's viewState into React
	// state (which would recreate the layer array on every pan/zoom frame).
	// Per the project's Deck.GL-native ADR memory.
	const zoomLabelRef = useRef<HTMLSpanElement | null>(null);

	// Memoised so a status/loading-message re-render doesn't rebuild the layer
	// array. Rebuilds only when visibility, manifests, or the selection setter
	// identity actually change (the latter is stable from useState).
	const layers = useMemo(
		() => buildLayers({ visible, manifests, onRegionClick: setSelection }),
		[visible, manifests, setSelection],
	);

	return (
		<div className="absolute inset-0 bg-neutral-900">
			<DeckGL
				initialViewState={INITIAL_VIEW_STATE}
				onViewStateChange={(params) => {
					// `viewState` is generically typed as MapViewState | TransitionProps;
					// we know it's MapView here so a narrow cast is safe.
					const zoom = (params.viewState as MapViewState).zoom;
					if (zoomLabelRef.current && typeof zoom === "number") {
						zoomLabelRef.current.textContent = `z ${zoom.toFixed(1)}`;
					}
				}}
				controller
				layers={layers}
				getTooltip={pickToTooltip}
			>
				<BaseMap mapStyle={MAP_STYLE} />
			</DeckGL>
			<ControlPanel
				status={status}
				visible={visible}
				onToggle={toggle}
				zoomLabelRef={zoomLabelRef}
				initialZoom={INITIAL_VIEW_STATE.zoom}
			/>
			<TileMemoryOverlay />
			<SuburbPlotPanel
				selection={selection}
				onClose={() => setSelection(null)}
			/>
		</div>
	);
};

export default App;
