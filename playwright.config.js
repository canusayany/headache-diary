import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 20000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: './test-results/e2e',
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }], ['html', { outputFolder: 'test-results/e2e-report', open: 'never' }]],
  use: {
    browserName: 'chromium', channel: 'msedge', headless: true,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block', actionTimeout: 5000,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'Edge-desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'Edge-small-dark', use: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true } },
  ],
});
