/// <reference types="vitest/config" />

import { existsSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Vite's SPA fallback would normally serve index.html (HTTP 200) for any
// missing path under /data/. MVTLayer's loaders.gl parser then reads the
// HTML bytes as MVT and throws "Unimplemented type: N" — `<` is 0x3c which
// looks like a protobuf field tag with wire type 4. Force a real 404 so the
// loader branches on response status instead. Production Pages already 404s
// correctly; this only changes dev to match.
const data404Middleware = (): Plugin => ({
	name: "hows-the-serenity:data-404",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			const url = req.url ?? "";
			if (!url.startsWith("/data/")) return next();
			const file = path.join(__dirname, "public", url.split("?")[0] ?? "");
			if (existsSync(file)) return next();
			res.statusCode = 404;
			res.end();
		});
	},
});

// `base` controls the URL prefix Vite bakes into asset paths.
// - Local dev / non-Pages builds: "/"
// - GitHub Pages: actions/configure-pages exports the project sub-path
//   (e.g. "/repo-name") and our workflow forwards it via PAGES_BASE_PATH.
// configure-pages emits NO trailing slash; Vite injects `import.meta.env.BASE_URL`
// verbatim, so user-side concatenation like `${BASE_URL}data/foo` would produce
// `/repo-namedata/foo`. Normalize once here so BASE_URL is always slash-terminated.
const rawBase = process.env.PAGES_BASE_PATH ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

export default defineConfig({
	base,
	plugins: [tailwindcss(), react(), data404Middleware()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		globals: true,
		environment: "jsdom",
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
		exclude: ["node_modules", "dist", ".claude"],
	},
});
