import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    {
      // The CSP in index.html allows Vite's dev websocket; a release build has no dev server, so it goes.
      name: "release-csp",
      apply: "build",
      transformIndexHtml: (html: string) => html.replace(" ws://localhost:1420", ""),
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // The frontend reads no env files (build.rs takes the OAuth client from .env.local). That file is a 1Password-mounted
  // pipe, which Vite saw as changed on every read and restarted the server for, dropping requests such as the icon font.
  envDir: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
