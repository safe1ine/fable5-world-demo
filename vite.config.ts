import { defineConfig } from "vite";

export default defineConfig(() => ({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    allowedHosts: ['.monkeycode-ai.online'],
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // tool-driven file writes are missed by fsevents on this setup; poll so
    // the module graph never serves stale code (cost: dev-only CPU)
    watch: { usePolling: true, interval: 200 },
  },
  esbuild: {
    target: "esnext",
  },
  base: "/",
}));
