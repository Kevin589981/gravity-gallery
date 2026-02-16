import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  server: {
    port: 4861,
    host: '0.0.0.0',
    https: {
      key: fs.readFileSync(
        process.env.VITE_DEV_KEY || path.resolve(__dirname, 'certificates', '<hostname>.local+1-key.pem')
      ),
      cert: fs.readFileSync(
        process.env.VITE_DEV_CERT || path.resolve(__dirname, 'certificates', '<hostname>.local+1.pem')
      ),
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
    preserveSymlinks: true,
  },
}));
