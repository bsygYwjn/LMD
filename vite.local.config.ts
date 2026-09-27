import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { jassubCspPlugin } from "./tools/jassub-csp-transform";

export default defineConfig({
  plugins: [react(), jassubCspPlugin()],
  worker: { plugins: () => [jassubCspPlugin()] },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8096",
    },
  },
  build: {
    outDir: "dist",
  },
});
