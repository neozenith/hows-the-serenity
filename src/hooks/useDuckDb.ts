import { useEffect, useRef, useState } from "react";
import { initRentalDb, type TableCount } from "@/lib/duckdb";

export type DbStatus =
	| { state: "loading"; message: string }
	| { state: "ready"; message: string; tables: TableCount[] }
	| { state: "error"; message: string };

// Run-once DuckDB bootstrap — fetches the .duckdb file, attaches it, and
// returns a status the UI can display. The duckdb module's own `_conn`
// singleton already short-circuits double-init, but the ref guard avoids
// the redundant `listTableCounts` round-trip under React StrictMode.
export const useDuckDb = (): DbStatus => {
	const [status, setStatus] = useState<DbStatus>({
		state: "loading",
		message: "Initialising DuckDB…",
	});
	const initOnce = useRef(false);

	useEffect(() => {
		if (initOnce.current) return;
		initOnce.current = true;

		initRentalDb({
			onProgress: (message) => setStatus({ state: "loading", message }),
		})
			.then((tables) =>
				setStatus({
					state: "ready",
					message: `Connected · ${tables.length} table${tables.length === 1 ? "" : "s"}`,
					tables,
				}),
			)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				setStatus({ state: "error", message });
				console.error("DuckDB init failed:", err);
			});
	}, []);

	return status;
};
