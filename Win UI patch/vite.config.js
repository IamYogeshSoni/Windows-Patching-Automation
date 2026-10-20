import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// /sccm-api/* is forwarded to the SCCM Patching API, so the browser talks to
// the same origin (no CORS setup, and it also works through a tunnel).
// SCCM_API_TARGET in .env.local overrides where the API runs.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const sccmProxy = {
    '/sccm-api': {
      target: env.SCCM_API_TARGET || 'http://127.0.0.1:8000',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/sccm-api/, ''),
    },
  }
  return {
    plugins: [react()],
    server: {
      port: 3000,
      open: true,
      allowedHosts: ['.trycloudflare.com'],
      proxy: sccmProxy,
    },
    preview: {
      allowedHosts: ['.trycloudflare.com'],
      proxy: sccmProxy,
    },
  }
})
