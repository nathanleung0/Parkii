import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Python venvs and recordings live in the repo; watching them crashes the dev server on Windows.
    watch: { ignored: ["**/agents/**", "**/worker/**", "**/.convex/**"] },
  },
});
