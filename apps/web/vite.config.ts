import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: run `bun run web:dev` together with the daemon (`SERVICE_ROLE=web`, port 8080). Proxies `/api` so the browser
// sees a single origin as in deploy; then set BETTER_AUTH_URL=http://localhost:5173.
export default defineConfig({
  // The router plugin must come before the react plugin (generates routeTree.gen.ts from src/routes).
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: false }), react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8080" } },
  build: { outDir: "dist", sourcemap: false },
});
