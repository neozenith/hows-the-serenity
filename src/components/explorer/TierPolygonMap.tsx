// Deck.GL polygon overlay for the /explore/overview cell drilldown.
//
// Given a tier (SAL/LGA), the loaded polygon GeoJSON, and a set of
// codes the user selected by clicking an Overview cell, paints ONLY
// those polygons. Per the user's "I want to visually inspect which
// polygons are being attributed to that metric" ask — the overlay must
// not paint unselected polygons, even faintly.
//
// Lazy: the SAL geojson is 11 MB so the component only fetches it on
// first cell click for its tier (see OverviewSummary's loader).
//
// Per the project's deck.gl convention (see auto-memory entry
// `feedback_deckgl_native_render_loop`), viewState lives inside deck.gl
// and is never lifted into React; the GeoJsonLayer's input is the
// pre-filtered FeatureCollection so the layer array doesn't allocate
// per viewport change.

import { GeoJsonLayer } from "@deck.gl/layers";
import { DeckGL, type MapViewState } from "deck.gl";
import type {
	Feature as GeoJsonFeature,
	FeatureCollection as GeoJsonFeatureCollection,
	GeoJsonProperties,
	Geometry,
} from "geojson";
import { useMemo } from "react";
import { Map as BaseMap } from "react-map-gl/maplibre";

import type { RegionTier } from "@/lib/overview-summary";
import { polygonHoverLabel } from "@/lib/polygon-tooltip";

// CartoDB dark-matter — matches the App.tsx basemap so the overview
// inherits the same visual context (street network + water + park polys
// underneath the highlighted SAL/LGA polygons).
const MAP_STYLE =
	"https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export type PolygonFeatureCollection = GeoJsonFeatureCollection<
	Geometry,
	GeoJsonProperties
>;
type PolygonFeature = GeoJsonFeature<Geometry, GeoJsonProperties>;

const CODE_FIELD: Record<RegionTier, string> = {
	sal: "SAL_CODE21",
	lga: "LGA_CODE24",
};

// Melbourne metro framing — every SAL/LGA in this dataset is Victorian
// so a fixed initial view is fine. Deck.GL will hold zoom + pan state
// internally; we never re-mount the component on cell click, just swap
// the filtered feature set.
const INITIAL_VIEW_STATE: MapViewState = {
	longitude: 144.96,
	latitude: -37.81,
	zoom: 7,
	pitch: 0,
	bearing: 0,
};

export const TierPolygonMap = ({
	tier,
	geojson,
	selectedCodes,
	cellLabel,
}: {
	tier: RegionTier;
	geojson: PolygonFeatureCollection | null;
	selectedCodes: ReadonlyArray<string>;
	cellLabel: string | null;
}) => {
	const codeField = CODE_FIELD[tier];

	// Pre-filter the FeatureCollection so the GeoJsonLayer only sees
	// the polygons the user asked for. Filtering at the layer level
	// (e.g. via getFilterValue) would still hand deck.gl all 2,946
	// SAL geometries; pre-filtering keeps both memory and paint cost
	// proportional to the selection.
	const filtered = useMemo<PolygonFeatureCollection | null>(() => {
		if (!geojson) return null;
		if (selectedCodes.length === 0)
			return { type: "FeatureCollection", features: [] };
		const wanted = new Set(selectedCodes);
		const features: PolygonFeature[] = geojson.features.filter((f) => {
			const code = f.properties?.[codeField];
			return typeof code === "string" && wanted.has(code);
		});
		return { type: "FeatureCollection", features };
	}, [geojson, selectedCodes, codeField]);

	const layers = useMemo(
		() =>
			filtered
				? [
						new GeoJsonLayer({
							id: `tier-polygons-${tier}`,
							data: filtered,
							stroked: true,
							filled: true,
							getFillColor: [99, 102, 241, 90],
							// Brighter outline + 2px floor so polygon edges stay
							// legible at every zoom; without lineWidthMinPixels the
							// stroke vanishes once a polygon shrinks below the
							// getLineWidth metres-per-pixel threshold.
							getLineColor: [165, 180, 252, 230],
							getLineWidth: 30,
							lineWidthMinPixels: 2,
							pickable: true,
						}),
					]
				: [],
		[filtered, tier],
	);

	const visibleCount = filtered?.features.length ?? 0;
	const requestedCount = selectedCodes.length;

	return (
		<figure
			data-testid={`tier-polygon-map-${tier}`}
			className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950"
		>
			<figcaption className="flex flex-wrap items-baseline justify-between gap-2 border-neutral-200 border-b px-3 py-2 text-xs dark:border-neutral-800">
				<span className="font-medium text-neutral-700 dark:text-neutral-200">
					{tier.toUpperCase()} polygon overlay
					{cellLabel && (
						<span
							className="ml-2 font-normal text-neutral-500 dark:text-neutral-400"
							data-testid={`tier-polygon-map-${tier}-label`}
						>
							{cellLabel}
						</span>
					)}
				</span>
				<span
					className="text-neutral-500 dark:text-neutral-400"
					data-testid={`tier-polygon-map-${tier}-count`}
				>
					{visibleCount.toLocaleString()} polygons painted
					{requestedCount !== visibleCount && (
						<>
							{" "}
							<span className="text-amber-600 dark:text-amber-400">
								({requestedCount.toLocaleString()} requested —{" "}
								{requestedCount - visibleCount} not found in the geojson)
							</span>
						</>
					)}
				</span>
			</figcaption>
			<div className="relative h-[360px] w-full">
				{!geojson ? (
					<div
						className="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm"
						data-testid={`tier-polygon-map-${tier}-loading`}
					>
						Loading {tier.toUpperCase()} geometry…
					</div>
				) : (
					<DeckGL
						initialViewState={INITIAL_VIEW_STATE}
						controller={true}
						layers={layers}
						getTooltip={({ object }) => {
							const feature = object as PolygonFeature | undefined;
							if (!feature?.properties) return null;
							const label = polygonHoverLabel(tier, feature.properties);
							if (!label) return null;
							return {
								text: label,
								style: {
									backgroundColor: "rgba(15, 23, 42, 0.92)",
									color: "#f8fafc",
									fontSize: "12px",
									padding: "4px 8px",
									borderRadius: "4px",
								},
							};
						}}
					>
						<BaseMap reuseMaps mapStyle={MAP_STYLE} />
					</DeckGL>
				)}
			</div>
		</figure>
	);
};
