import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [svelte()],
  server: {
    // Expose on the LAN so the app can be opened on a real phone —
    // touch gestures and the virtual keyboard cannot be trusted to emulators.
    host: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
