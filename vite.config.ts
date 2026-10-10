import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    publicDir: 'public',
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // The renderer always calls fetch('/api/...'). In Electron the local
      // server serves both the app and the API on one origin, so this proxy is
      // only needed for browser development (npm run dev + npm run dev:api).
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${process.env.ANDA_API_PORT || 4310}`,
          changeOrigin: false,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            ui: ['lucide-react'],
          },
        },
      },
    },
  };
});