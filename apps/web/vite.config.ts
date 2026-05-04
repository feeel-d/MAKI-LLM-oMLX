import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isPages = process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  plugins: [react()],
  base: isPages ? "/MAKI-LLM-oMLX/" : "/",
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
