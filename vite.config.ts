/// <reference types="vitest/config" />

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `base` controls the URL prefix Vite bakes into asset paths.
// - Local dev / non-Pages builds: "/"
// - GitHub Pages: actions/configure-pages exports the project sub-path
//   (e.g. "/repo-name/") and our workflow forwards it via PAGES_BASE_PATH.
const base = process.env.PAGES_BASE_PATH ?? "/";

export default defineConfig({
	base,
	plugins: [tailwindcss(), react()],
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
