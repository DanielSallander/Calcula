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
        editor: path.resolve(__dirname, 'editor.html'),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        chartSpecEditor: path.resolve(__dirname, 'chartSpecEditor.html'),
      },
    },
  },
});