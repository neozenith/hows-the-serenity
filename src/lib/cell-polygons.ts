// Pure helpers for the /explore/overview cell→polygon-map drilldown.
//
// The vendor's rental feed publishes some suburbs as multi-SAL group
// strings, e.g. "20018-21677" for two adjacent SALs that share one
// rental observation. The `geospatial_codes` column in `rental_sales`
// and `forecasts` carries that string verbatim, so a naive
// COUNT(DISTINCT geospatial_codes) (and a polygon overlay keyed on it)
// would either over-count distinct row-keys or skip every polygon in a
// group. This helper flattens those strings to singleton codes so the
// overlay can paint EVERY polygon represented by the cell.

export const flattenCellCodes = (rowKeys: ReadonlyArray<string>): string[] => {
	const out = new Set<string>();
	for (const key of rowKeys) {
		if (key.length === 0) continue;
		for (const piece of key.split("-")) {
			const trimmed = piece.trim();
			if (trimmed.length > 0) out.add(trimmed);
		}
	}
	return [...out].sort();
};
