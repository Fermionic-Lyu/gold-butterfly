import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Default outDir: "dist". The InsForge deploy CLI excludes "dist"
  // from uploads on purpose — Vercel rebuilds from source on every
  // deploy, so there's no value in shipping the local build artifact.
})
