import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地启动脚本使用 .env 中的 PORT=3005；保持前端代理与后端端口一致，
// 否则页面虽然能打开，但所有 /api 请求都会报 Network Error。
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3005'

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
