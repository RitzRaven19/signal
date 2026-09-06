import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api to FastAPI during dev so the browser sees one origin --
// no CORS needed, matching how the built app is served in production.
// cors:false is load-bearing, not cosmetic: Vite's own dev-server CORS
// default (true) stamps Access-Control-Allow-Origin on every response,
// proxied ones included. That alone makes Chromium evaluate the
// response under CORS rules -- and without a matching
// Access-Control-Allow-Credentials, it silently drops the backend's
// Set-Cookie, so signal_user_id never survives a page reload in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    cors: false,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
