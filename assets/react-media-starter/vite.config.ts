import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: process.env.REACT_MEDIA_OUT_DIR || 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
