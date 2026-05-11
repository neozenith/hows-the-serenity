// Enumeration of the rental/sales hex-series surfaced in the frontend.
//
// One series per (data_type, geospatial_type, dwelling_type, bedrooms)
// combination present in the rental_sales DuckDB. Sales is suburb-only;
// rental publishes both suburb and LGA tiers from VIC DTF.
//
// `id` is the stable key used in URL params / sessionStorage / DuckDB
// joins; treat it as opaque. `label` is the user-facing text shown in
// the series picker. The picker groups by (data_type, geospatial_type)
// to keep the dropdown navigable.

export type DataType = "rental" | "sales";
export type RegionTier = "suburb" | "lga";

export type RentalHexSeries = {
	id: string;
	dataType: DataType;
	regionTier: RegionTier;
	dwellingType: string; // "house" | "unit" | "vacant_land" | "all"
	bedrooms: string; // "1" | "2" | "3" | "4" | "all" | "0"
	label: string;
	group: string; // grouping header in the dropdown
};

const seriesId = (
	dataType: DataType,
	regionTier: RegionTier,
	dwellingType: string,
	bedrooms: string,
): string => `${dataType}-${regionTier}-${dwellingType}-${bedrooms}`;

const make = (
	dataType: DataType,
	regionTier: RegionTier,
	dwellingType: string,
	bedrooms: string,
	label: string,
): RentalHexSeries => ({
	id: seriesId(dataType, regionTier, dwellingType, bedrooms),
	dataType,
	regionTier,
	dwellingType,
	bedrooms,
	label,
	group: `${dataType === "rental" ? "Rental" : "Sales"} · ${regionTier === "suburb" ? "suburb" : "LGA"}`,
});

// Order matches the YAML schema's natural reading: dwelling types in a
// stable order, bedroom counts ascending. Keeps the dropdown predictable.
export const RENTAL_HEX_SERIES: ReadonlyArray<RentalHexSeries> = [
	// Rental · suburb (7)
	make("rental", "suburb", "unit", "1", "Unit · 1 bedroom"),
	make("rental", "suburb", "unit", "2", "Unit · 2 bedroom"),
	make("rental", "suburb", "unit", "3", "Unit · 3 bedroom"),
	make("rental", "suburb", "house", "2", "House · 2 bedroom"),
	make("rental", "suburb", "house", "3", "House · 3 bedroom"),
	make("rental", "suburb", "house", "4", "House · 4 bedroom"),
	make("rental", "suburb", "all", "all", "All properties"),
	// Rental · LGA (7)
	make("rental", "lga", "unit", "1", "Unit · 1 bedroom"),
	make("rental", "lga", "unit", "2", "Unit · 2 bedroom"),
	make("rental", "lga", "unit", "3", "Unit · 3 bedroom"),
	make("rental", "lga", "house", "2", "House · 2 bedroom"),
	make("rental", "lga", "house", "3", "House · 3 bedroom"),
	make("rental", "lga", "house", "4", "House · 4 bedroom"),
	make("rental", "lga", "all", "all", "All properties"),
	// Sales · suburb (3)
	make("sales", "suburb", "house", "all", "House"),
	make("sales", "suburb", "unit", "all", "Unit"),
	make("sales", "suburb", "vacant_land", "0", "Vacant land"),
];

export const RENTAL_HEX_SERIES_BY_ID: ReadonlyMap<string, RentalHexSeries> =
	new Map(RENTAL_HEX_SERIES.map((s) => [s.id, s]));
