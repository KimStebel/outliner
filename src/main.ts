import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app

// Offline support. Registered only in a production build: a service worker in
// front of the dev server would serve stale modules and fight HMR.
//
// Note this silently does nothing unless the page is a secure context —
// https, or localhost. Over plain http to a LAN address the browser refuses
// to register one, so the app still works but cannot be installed.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('[outliner] offline support unavailable', error)
    })
  })
}
