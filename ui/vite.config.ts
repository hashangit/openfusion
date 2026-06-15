import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built UI is served by the OpenFusion Express server (same origin),
// so the dev server proxies /api to the local backend during development.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:9077",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
