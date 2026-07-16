import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Substitutes server-side template placeholders with dev defaults so the
// Vite dev server works without running a build first.
const injectDevVars = {
  name: 'inject-dev-vars',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    // The `${rootPath}` and `${version}` literals are intentional
    // template-placeholder strings in index.html that get replaced
    // here at build time -- they're NOT JS template-literal expressions
    // (this code is a string-replace, not interpolation).
    return html
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template placeholder.
      .replace('${rootPath}', '')
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template placeholder.
      .replace('${version}', process.env.VERSION ?? 'dev');
  },
};

export default defineConfig({
  base: './',
  plugins: [
    react(),
    injectDevVars,
    VitePWA({
      registerType: 'autoUpdate',
      // Escape hatch for local iteration: PWA_KILL=1 ships a service
      // worker that unregisters itself and purges caches, so a stale
      // precache can't keep serving old assets while we test UI changes.
      selfDestroying: process.env.PWA_KILL === '1',
      // Use the existing manifest.webmanifest from static/ -- don't generate one.
      manifest: false,
      workbox: {
        // Exclude html: index.html contains server-side template variables
        // (${rootPath}) that are substituted at request time by the Node
        // server. If the SW cached the raw build output it would serve
        // unresolved template literals, breaking the WebSocket URL.
        // Navigations always go to the server so the HTML is always fresh.
        globPatterns: ['**/*.{js,css,ico,png,svg,webmanifest,woff2}'],
        runtimeCaching: [
          {
            // Never cache API or WebSocket upgrade requests.
            // Match on pathname so the pattern works against full URLs (scheme+host+path).
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            // Poster images: network-first so fresh art loads when online,
            // falls back to cached version when offline.
            urlPattern: ({ url }) => url.pathname.includes('/poster/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'posters',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
  publicDir: 'static',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  define: {
    'import.meta.env.VERSION': JSON.stringify(process.env.VERSION ?? 'dev'),
  },
})
