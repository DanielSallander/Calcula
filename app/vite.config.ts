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

    // ========================================================================
    // THE DEV SERVER MUST NOT WATCH THE RUST BUILD TREE. (BUG-0082)
    // ========================================================================
    // Vite's default watcher is `chokidar.watch(root)` -- root is `app/` -- and
    // `app/src-tauri/` holds an in-repo Cargo `target/` of **100,175 files in
    // 9,118 directories**. Registering a native `fs.watch` for each of those on
    // Windows blocks the dev server's ONE thread, and it does it AFTER
    // `server.listen()` has already printed "ready in 380 ms" and started
    // answering HTTP. So the server looks up, serves `index.html` instantly,
    // and then starves every module request behind the walk.
    //
    // THAT is the empty-`#root` cold start. The page loads, `<div id="root">`
    // is present and empty, `window.__calcImport` is absent because
    // `/src/main.tsx` has not been served yet, and the harness's 60 s fixture
    // ceiling reports it as N product timeouts.
    //
    // MEASURED 2026-08-15, dev server alone (no cargo, no app.exe, no WebView2
    // -- so CPU contention is excluded), crawling the 1,420-module graph over
    // HTTP exactly as the browser does:
    //
    //   watcher default   1,420 modules in 37.0 s / 37.4 s / 62 s / >120 s
    //                     (one run served THREE modules in 120 s)
    //   watcher ignoring  1,420 modules in  3.4 s /  3.3 s /  3.7 s
    //     src-tauri
    //
    //   chokidar watched  9,720 dirs / 113,460 entries  ->  545 / 3,443
    //   second traversal  0.4-0.6 s in BOTH  <- the transform is never the cost
    //
    // A CPU profile of the slow traversal put **74.5 % of samples** in one
    // stack: `_addToNodeFs` -> `_watchWithNodeFs` -> `createFsWatchInstance` ->
    // `node:fs.watch` -> native `FSWatcher.start`. Not transform time, not a
    // deadlock, not Vite's dependency optimizer (which logged "Hash is
    // consistent. Skipping"). Watcher registration, once per dev-server start,
    // which is why every re-run "passed": the SECOND traversal against a server
    // that is already up costs 0.5 s.
    //
    // Nothing here needs watching. `src-tauri` is Rust -- Tauri's own dev
    // watcher rebuilds it and a change there restarts the app; Vite has no
    // stake in it. The rest are outputs: goldens, results, bundles.
    //
    // Pinned by e2e/__tests__/viteWatchExclusions.test.ts.
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/e2e/results/**",
        "**/e2e/**/*-snapshots/**",
        "**/test-results/**",
        "**/dist/**",
      ],
    },
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