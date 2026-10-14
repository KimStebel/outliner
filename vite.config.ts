import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'
import { serviceWorker } from './build/sw-plugin.ts'

export default defineConfig({
  plugins: [svelte(), serviceWorker()],
  server: {
    // Expose on the LAN so the app can be opened from outside this VM, and on
    // a real phone — touch gestures and the virtual keyboard cannot be trusted
    // to emulators.
    host: true,
    port: 8080,
    // Fail instead of quietly moving to 8081, which would not be the port
    // forwarded to the host.
    strictPort: true,
    // Accept any Host header. Vite otherwise rejects requests whose hostname
    // it does not recognise, which blocks reaching the VM by hostname, through
    // a tunnel, or via any forwarding alias. This disables Vite's DNS-rebinding
    // protection, so keep it to trusted networks — it is a dev-only setting and
    // does not affect `build` or `preview`.
    allowedHosts: true,
    // Point /api at a locally-run backend:
    //   cargo run --manifest-path backend/Cargo.toml
    // with DATA_DIR set somewhere scratch and BIND=127.0.0.1:8787.
    // In production Caddy does this, and adds the basic auth.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
      // Rauthy, started by deploy/rauthy/rauthy-local.sh. Proxied rather than
      // reached on its own port so the browser sees one origin, as it will in
      // production where Caddy does this: the issuer, the cookies and the CSP
      // all depend on the app and the identity provider sharing an origin.
      //
      // changeOrigin stays false so the Host header remains localhost:8080,
      // which is what Rauthy is configured as `pub_url` and checks against.
      '/auth': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
    watch: {
      // This project lives on a 9p share from the VM host, and 9p does not
      // deliver inotify events to the guest. Without polling the watcher never
      // fires: no HMR, and even a hard reload serves the cached transform of a
      // file that changed on disk. Vite already excludes node_modules from the
      // watch set, so this only polls source.
      usePolling: true,
      interval: 300,
    },
  },
  preview: {
    // Same port as the dev server, since that is the one forwarded out of the
    // VM. Only one of the two runs at a time. Use this to exercise the
    // service worker, which is deliberately absent from the dev server.
    host: true,
    port: 8080,
    strictPort: true,
    allowedHosts: true,
    // Point /api at a locally-run backend:
    //   cargo run --manifest-path backend/Cargo.toml
    // with DATA_DIR set somewhere scratch and BIND=127.0.0.1:8787.
    // In production Caddy does this, and adds the basic auth.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
      '/auth': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
})
