import * as duckdb from "@duckdb/duckdb-wasm";

export interface TableCount {
	name: string;
	rows: number;
}

export interface InitOptions {
	onProgress?: (message: string) => void;
}

const DB_FILENAME = "rental_sales.duckdb";
const DB_ALIAS = "rental_sales";
const DB_URL = `${import.meta.env.BASE_URL}data/${DB_FILENAME}`;

// Module-level singleton connection. Kept open after init so subsequent
// queries (rental-sales chart) can share the same WASM database without
// re-fetching the .duckdb file. Don't close until tab close.
let _conn: duckdb.AsyncDuckDBConnection | null = null;

const toNumber = (v: unknown): number => {
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "number") return v;
	return Number(v);
};

export const initRentalDb = async ({
	onProgress,
}: InitOptions = {}): Promise<TableCount[]> => {
	if (_conn) {
		// Already initialised in this session — just re-list tables for the
		// status panel without re-fetching the .duckdb file. React StrictMode
		// double-invokes effects in dev so this guard matters.
		const counts = await listTableCounts(_conn);
		return counts;
	}

	onProgress?.("Selecting DuckDB bundle…");
	const bundles = duckdb.getJsDelivrBundles();
	const bundle = await duckdb.selectBundle(bundles);

	if (!bundle.mainWorker) {
		throw new Error("DuckDB bundle is missing a main worker URL");
	}

	// Same Blob-importScripts trick the original VanillaJS app used: lets the
	// CDN-hosted worker run from a same-origin URL so it can `importScripts()`.
	const workerUrl = URL.createObjectURL(
		new Blob([`importScripts("${bundle.mainWorker}");`], {
			type: "text/javascript",
		}),
	);
	const worker = new Worker(workerUrl);
	const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
	const db = new duckdb.AsyncDuckDB(logger, worker);

	onProgress?.("Instantiating WASM module…");
	await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
	URL.revokeObjectURL(workerUrl);

	const conn = await db.connect();

	onProgress?.(`Fetching ${DB_FILENAME}…`);
	const response = await fetch(DB_URL);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${DB_URL}: ${response.status} ${response.statusText}`,
		);
	}
	const buffer = new Uint8Array(await response.arrayBuffer());

	onProgress?.("Attaching database…");
	await db.registerFileBuffer(DB_FILENAME, buffer);
	await conn.query(`ATTACH '${DB_FILENAME}' AS ${DB_ALIAS} (READ_ONLY);`);

	_conn = conn;

	onProgress?.("Counting tables…");
	return listTableCounts(conn);
};

const listTableCounts = async (
	conn: duckdb.AsyncDuckDBConnection,
): Promise<TableCount[]> => {
	const tablesResult = await conn.query(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_catalog = '${DB_ALIAS}' AND table_schema = 'main'
		 ORDER BY table_name;`,
	);
	const tableNames = tablesResult
		.toArray()
		.map((row) => String(row.table_name as unknown));

	const counts: TableCount[] = [];
	for (const name of tableNames) {
		// Identifiers are sourced from information_schema (not user input), but
		// quote them defensively to handle reserved words / mixed case.
		const countResult = await conn.query(
			`SELECT COUNT(*)::BIGINT AS n FROM ${DB_ALIAS}."${name}";`,
		);
		const row = countResult.toArray()[0] as { n?: unknown } | undefined;
		counts.push({ name, rows: toNumber(row?.n) });
	}
	return counts;
};

// Public accessor so other modules (rental-sales-query.ts) can run queries
// against the already-attached database without re-fetching the file.
export const getRentalDbConn = (): duckdb.AsyncDuckDBConnection | null => _conn;

export const RENTAL_DB_ALIAS = DB_ALIAS;
