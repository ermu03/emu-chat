import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget =
  process.env["EMU_CHAT_SERVER_URL"] ?? "http://127.0.0.1:3104";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
});
