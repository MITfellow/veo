import { defineConfig, devices } from '@playwright/test';

/** E2E runs against the real production build served by `vite preview`. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // the camera and microphone specs drive real getUserMedia and MediaRecorder
    // against Chromium's synthetic devices, so the media path is exercised for
    // real rather than mocked out
    permissions: ['geolocation'],
    geolocation: { latitude: 28.6692, longitude: 77.4538, accuracy: 18 },
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  // Two processes, because the product is two processes. The agent runs on
  // a scratch database with a known token so `agent.spec.ts` can talk to the
  // real runtime instead of a mock of it; the preview server proxies to it
  // exactly as the dev server does.
  webServer: [
    {
      command:
        'ARISH_DB=.arish/e2e.db ARISH_TOKEN=dev-token ARISH_PORT=7777 npx tsx agent/src/main.ts',
      url: 'http://127.0.0.1:7777/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run build && npm run preview -- --port 4173 --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
