// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://aroramsp.com',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/blog/samples/')
    })
  ],
  vite: {
    plugins: [tailwindcss()]
  }
});