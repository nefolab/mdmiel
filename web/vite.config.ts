import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8686',
        changeOrigin: true,
      },
      '/raw': {
        target: 'http://127.0.0.1:8686',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // @ts-ignore
  test: {
    globals: true,
    environment: 'jsdom',
    css: true,
    onConsoleLog(log, type) {
      if (
        type === 'stderr'
        && log.includes('Could not parse CSS stylesheet')
        && log.includes('@layer hljs-theme')
      ) {
        return false;
      }
    },
  },
});
