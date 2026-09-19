import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The PWA service worker (vite-plugin-pwa) is disabled while this app is
// under active, fast iteration: its content-hashed precache goes stale on
// every rebuild (old JS chunk names get deleted by emptyOutDir), which was
// crashing the app with React "insertBefore" DOM errors for anyone who had
// an old service worker still installed. See public/sw.js for the
// self-unregistering worker that cleans up any previously installed one.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: '../src/openjarvis/server/static',
    emptyOutDir: true,
    // Preserve the Vite 6 browser baseline for existing desktop webviews.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom)[\\/]/ },
            {
              name: 'markdown',
              test: /node_modules[\\/](react-markdown|rehype-highlight|remark-gfm)[\\/]/,
            },
            { name: 'charts', test: /node_modules[\\/]recharts[\\/]/ },
            { name: 'router', test: /node_modules[\\/]react-router[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // ws: true is required for the /v1/agents/events WebSocket. Without it
      // Vite proxies the HTTP request but not the upgrade, so the socket never
      // opens — no error, no close event, just silence — and every live agent
      // view sits empty in dev while working in a production build.
      '/v1': {
        target: process.env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
      '/health': process.env.VITE_API_URL || 'http://localhost:8000',
      '/api': process.env.VITE_API_URL || 'http://localhost:8000',
    },
  },
});
