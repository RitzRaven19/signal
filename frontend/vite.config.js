import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api to FastAPI during dev so the browser sees one origin --
// no CORS needed, matching how the built app is served in production.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
