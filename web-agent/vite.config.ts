import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 云端沙箱 / 远程浏览器预览的关键约束：
//   1. 开发服务器必须监听 0.0.0.0，否则 https://{port}-{sandbox}.e2b.app 访问不到；
//   2. allowedHosts: true，放行反代域名（否则 Vite 会返回 403 blocked host）；
//   3. /api 与 /preview 走同源代理，前端永不直连 localhost。
export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/preview': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },
});
