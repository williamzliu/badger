import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.BADGER_API ?? 'http://localhost:3000';
const proxied = ['/sessions', '/health', '/internal', '/webhooks'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((path) => [path, { target: BACKEND, changeOrigin: true }])),
  },
});
