import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [svelte()],
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
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
