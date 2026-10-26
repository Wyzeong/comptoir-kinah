import { defineConfig } from 'vite';

// Sur GitHub Pages le site vit sous /<nom-du-dépôt>/ : la GitHub Action passe VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
});
