import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // Agency Agents uses 1430 (NOT 1420) so it never collides with the
    // brew-browser dev server it was forked from — both default to 1420, and a
    // shared port makes one app's webview load the other's frontend.
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Web build (`node web/server.mjs`): proxy the invoke bridge so
    // `npm run dev` works against the same backend as production.
    proxy: {
      "/api": {
        target: "http://localhost:8788",
        changeOrigin: false,
      },
    },
  },
}));
