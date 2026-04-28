import { useEffect } from "react";
import { loadSuburbMappings } from "@/lib/suburb-mappings";

// Fire-and-forget load of the SAL → rental_sales market group mapping.
// Failure is non-fatal: the SuburbPlot falls back to raw SAL_NAME21 /
// SAL_CODE21 when the mapping isn't loaded.
export const useSuburbMappings = (): void => {
	useEffect(() => {
		loadSuburbMappings(`${import.meta.env.BASE_URL}data/suburb_mappings.json`)
			.then((m) => {
				console.log(
					`[suburb-mappings] loaded · ${m.summary.totalSALs} SALs, ${m.summary.withRentalData} with rental, ${m.summary.withSalesData} with sales`,
				);
			})
			.catch((err: unknown) => {
				console.error("Suburb mappings load failed:", err);
			});
	}, []);
};
