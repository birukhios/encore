import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ENCORE_APP selects which app a dev server serves; both proxy API calls and images to the .NET API.
const app = process.env.ENCORE_APP || 'admin';
const apiPort = process.env.ENCORE_API_PORT || 8080;

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { admin: 'admin.html', guest: 'guest.html' },
      output: {
        manualChunks: id => {
          // PDF export libraries load on demand only; keep them out of the app's startup chunks.
          if (/node_modules\/(jspdf|jspdf-autotable|html2canvas|dompurify|canvg|fflate|core-js|raf|rgbcolor|stackblur-canvas|svg-pathdata|performance-now|@babel)/.test(id)) return 'pdf';
          if (id.includes('node_modules')) return 'vendor';
          if (id.includes('/src/shared/')) return 'shared';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    open: false,
    proxy: { '/admin/api': `http://127.0.0.1:${apiPort}`, '/api': `http://127.0.0.1:${apiPort}`, '/uploads': `http://127.0.0.1:${apiPort}` },
  },
  appType: 'mpa',
  plugins: [
    react(),
    {
      name: 'encore-app-entry',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const path = req.url.split('?')[0];
          if (!path.startsWith('/@') && !path.startsWith('/src/') && !path.startsWith('/node_modules/') && !path.startsWith('/api') && !path.startsWith('/uploads') && !path.includes('.')) {
            req.url = '/' + app + '.html' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
          }
          next();
        });
      },
    },
  ],
});
