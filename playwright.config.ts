import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    channel: 'chrome',
  },
})
