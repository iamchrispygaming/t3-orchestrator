import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env.T3O_PORT ?? 4317);

export default defineConfig({
  root: fileURLToPath(new URL('src/web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    // changeOrigin sends the server's own Host, which its guard requires.
    proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
  },
});
