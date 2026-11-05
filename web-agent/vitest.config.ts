import { defineConfig } from 'vitest/config';

// 单独的 vitest 配置：vite.config.ts 的 root 指向 client/，测试需要跑在 web-agent 根目录。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: 'default',
  },
});
