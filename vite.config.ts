import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project site: https://<user>.github.io/photo-locations/
export default defineConfig({
  plugins: [react()],
  base: '/photo-locations/',
})
