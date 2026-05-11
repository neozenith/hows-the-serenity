import { DeckGL, type MapViewState } from "deck.gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as BaseMap } from "react-map-gl/maplibre";
import { ControlPanel } from "@/components/ControlPanel";
import { HexSeriesPicker } from "@/components/HexSeriesPicker";
import { SuburbPlotPanel } from "@/components/SuburbPlotPanel";
import { TileMemoryOverlay } from "@/components/TileMemoryOverlay";
import { useActiveHexSeries } from "@/hooks/useActiveHexSeries";
import { useDuckDb } from "@/hooks/useDuckDb";
import { useLatestRentalSeries } from "@/hooks/useLatestRentalSeries";
import { useLayerVisibility } from "@/hooks/useLayerVisibility";
import { useRegionH3Cells } from "@/hooks/useRegionH3Cells";
import { useRegionNames } from "@/hooks/useRegionNames";
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
	const {
		visible,
		toggle,
		reset: resetVisibility,
		setAll: setAllVisibility,
	} = useLayerVisibility();
	// Hex layer is a memory-heavy feature — gate the H3 cell fetch on the
	// panel toggle so disabling it actually releases the ~3 MB cell data.
	const hexEnabled = visible.rentalHex;
	const h3Cells = useRegionH3Cells(hexEnabled);
	const regionNames = useRegionNames();
	const hexSeriesValues = useLatestRentalSeries(status);
	const { activeId: activeHexSeriesId, select: selectHexSeries } =
		useActiveHexSeries();
	// Filter resets to null (= no filter, show full range) whenever the
	// active series changes. Different series have wildly different
	// magnitudes ($300/wk rental vs $1.5M sales), so a carried-over filter
	// from another series would be meaningless. We compare prev vs current
	// inside the effect (rather than just listing the dep) so Biome's
	// useExhaustiveDependencies rule doesn't autofix it away as unread.
	const [hexValueFilter, setHexValueFilter] = useState<
		readonly [number, number] | null
	>(null);
	const prevHexSeriesIdRef = useRef<string | null>(activeHexSeriesId);
	useEffect(() => {
		if (prevHexSeriesIdRef.current !== activeHexSeriesId) {
			prevHexSeriesIdRef.current = activeHexSeriesId;
			setHexValueFilter(null);
		}
	}, [activeHexSeriesId]);

	// 3D extrusion of the hex layer, height proportional to value. Persisted
	// in sessionStorage so a refresh keeps the user's preference within a
	// tab. Same pattern as useActiveHexSeries / useLayerVisibility.
	const [hex3D, setHex3D] = useState<boolean>(() => {
		try {
			return window.sessionStorage.getItem("hts:hex-3d:v1") === "true";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		try {
			window.sessionStorage.setItem("hts:hex-3d:v1", String(hex3D));
		} catch (e) {
			console.warn("hex-3d: sessionStorage write failed", e);
		}
	}, [hex3D]);
	const activeSeriesValues = activeHexSeriesId
		? (hexSeriesValues.get(activeHexSeriesId) ?? null)
		: null;
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
		() =>
			buildLayers({
				visible,
				manifests,
				onRegionClick: setSelection,
				activeHexSeriesId,
				hexSeriesValues,
				h3Cells,
				regionNames,
				hexValueFilter,
				hex3D,
			}),
		[
			visible,
			manifests,
			setSelection,
			activeHexSeriesId,
			hexSeriesValues,
			h3Cells,
			regionNames,
			hexValueFilter,
			hex3D,
		],
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
				onResetVisibility={resetVisibility}
				onSetAllVisibility={setAllVisibility}
				zoomLabelRef={zoomLabelRef}
				initialZoom={INITIAL_VIEW_STATE.zoom}
			/>
			{hexEnabled && (
				<HexSeriesPicker
					activeId={activeHexSeriesId}
					onSelect={selectHexSeries}
					activeSeriesValues={activeSeriesValues}
					valueFilter={hexValueFilter}
					onValueFilterChange={setHexValueFilter}
					threeD={hex3D}
					onThreeDChange={setHex3D}
				/>
			)}
			<TileMemoryOverlay />
			<SuburbPlotPanel
				selection={selection}
				onClose={() => setSelection(null)}
			/>
		</div>
	);
};

export default App;
