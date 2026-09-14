import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    // Served as static files by Express in production.
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // In dev the API and OAuth routes stay on the Express server.
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/health": "http://localhost:3000",
      // So APP_URL works as one origin in dev, the way it does in production. Twilio signatures
      // are computed over APP_URL, so mock requests have to reach /sms through it too.
      "/sms": "http://localhost:3000",
    },
  },
});
