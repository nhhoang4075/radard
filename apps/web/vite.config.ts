import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: chạy `bun run web:dev` cùng daemon (`SERVICE_ROLE=web`, cổng 8080). Proxy `/api` để trình duyệt
// thấy một origin duy nhất như khi deploy; khi đó đặt BETTER_AUTH_URL=http://localhost:5173.
export default defineConfig({
  // Plugin router phải đứng trước plugin react (sinh routeTree.gen.ts từ src/routes).
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: false }), react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8080" } },
  build: { outDir: "dist", sourcemap: false },
});
