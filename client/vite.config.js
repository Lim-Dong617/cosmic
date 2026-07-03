import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        host: '0.0.0.0',
        proxy: {
            '/api': {
                target: apiProxyTarget,
                changeOrigin: true
            }
        }
    },
    build: {
        outDir: 'dist',
        sourcemap: false
    }
})
