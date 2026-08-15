import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  
  // ARCHITECTURE: Path Aliases
  // This ensures Vite understands the shortcuts defined in tsconfig
  resolve: {
    alias: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      '@api': path.resolve(__dirname, './src/api'),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      '@core': path.resolve(__dirname, './src/core'),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      '@shell': path.resolve(__dirname, './src/shell'),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    // ========================================================================
    // THE E2E APP IS NOT HOT-RELOADABLE.
    // ========================================================================
    // `CALCULA_E2E=1` is set by BOTH E2E launchers (e2e/global-setup.ts and
    // e2e/launch-app.mjs) on the `tauri dev` child, and by nothing else, so
    // interactive development keeps HMR exactly as it is.
    //
    // WHY, MEASURED 2026-08-15 on an isolated app while another agent saved
    // app/src/core/lib/events.ts: Vite pushed `hmr update` for ~170 modules
    // (and `page reload (circular import invalidate)` for several). React
    // fast-refresh remounted the provider tree, so GridProvider's `useReducer`
    // restarted from `getInitialState()` -- the selection snapped from W7 back
    // to A1 and scrollX from 286 to 0, about 2.5 s AFTER the harness had
    // deliberately parked them.
    //
    // The reason this is worth a config option rather than a note: there is NO
    // NAVIGATION. `performance.timeOrigin` is unchanged and a window marker
    // installed beforehand survives, so neither the page nor Playwright can
    // tell that the app was reset underneath a capture. A golden taken across
    // that window photographs the editor and is indistinguishable from a
    // product change. With the channel cut, the same state held still for 10 s
    // and the same capture came back byte-identical 8 runs out of 8.
    //
    // Pinned by e2e/__tests__/hmrDisabledForE2E.test.ts, which also checks that
    // both launchers still set the flag -- the guard is worthless if either
    // half drifts.
    hmr: process.env.CALCULA_E2E === "1" ? false : undefined,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        main: path.resolve(__dirname, 'index.html'),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        chartSpecEditor: path.resolve(__dirname, 'chartSpecEditor.html'),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        objectScript: path.resolve(__dirname, 'objectScript.html'),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        modelEditor: path.resolve(__dirname, 'modelEditor.html'),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        packageInspector: path.resolve(__dirname, 'packageInspector.html'),
      },
    },
  },
});