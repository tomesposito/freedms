import { defineConfig } from 'vite';
export default defineConfig({define: {global: 'globalThis'}, build: {assetsInlineLimit: 0}, server: {port: 5173, strictPort: true, proxy: {'/api': {target: 'http://127.0.0.1:3001', changeOrigin: true, rewrite: path => path.replace(/^\/api/, '')}}}});
