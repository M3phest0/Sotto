import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/ui',
  // 首次加载 Vite 冷启动在 Windows 上可能超过 30s，避免并行文件互相争用导致误报。
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    channel: 'chrome',
  },
})
