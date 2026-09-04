import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The API server owns /api; in dev, Vite proxies to it so the browser
    // sees one origin (session cookie stays first-party).
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 8080}`,
        changeOrigin: false,
      },
    },
  },
})
