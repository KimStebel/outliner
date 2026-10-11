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
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
