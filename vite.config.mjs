import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ENCORE_APP selects which app a dev server serves and which Python port it proxies to.
const app = process.env.ENCORE_APP || 'admin';
const apiPort = app === 'guest' ? process.env.GUEST_PORT || 8082 : process.env.PORT || 8081;

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { admin: 'admin.html', guest: 'guest.html' },
      output: { manualChunks: id => (id.includes('node_modules') ? 'vendor' : id.includes('/src/shared/') ? 'shared' : undefined) },
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
