import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    // Keeps the browser same-origin so no CORS config is needed on mandate-svc.
    proxy: { "/v1": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
