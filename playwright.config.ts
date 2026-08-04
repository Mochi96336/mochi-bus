import { defineConfig, devices } from '@playwright/test'

type RuntimeProcess = { env?: Record<string, string | undefined> }
const runtimeEnv = (globalThis as typeof globalThis & { process?: RuntimeProcess }).process?.env
const isCI = Boolean(runtimeEnv?.CI)
const isWorkerStatefulRun = runtimeEnv?.PLAYWRIGHT_WORKER_STATEFUL === '1'
const workerStatefulSpec = /worker-stateful\.spec\.ts/

// 這裡是「起真的瀏覽器點畫面」的整合測試,跟 vitest 的 node/workers project
// 分開:desktop 跑所有非視覺流程,touch project 只跑需要真實觸控能力的規格,
// Worker module state 測試另開單 worker project,CI 再用獨立 Playwright process 啟動新 Wrangler。
// 視覺快照另立 project,讓 CI 能完整跑互動矩陣而不依賴平台限定的圖片。
export default defineConfig({
  testDir: 'test/e2e',
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}',
  webServer: {
    command: 'npm run dev -- --var PLAYWRIGHT_TEST_MODE:1',
    url: 'http://127.0.0.1:8787/',
    reuseExistingServer: !isCI && !isWorkerStatefulRun,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8787',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: [/mobile-touch\.spec\.ts/, /(?:map|ui)-visual\.spec\.ts/, workerStatefulSpec],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-touch',
      testMatch: [
        /mobile-touch\.spec\.ts/,
        /map-navigation-equivalence\.spec\.ts/,
        /map-async-navigation\.spec\.ts/,
        /setup\.spec\.ts/,
        /setup-modal\.spec\.ts/,
      ],
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'worker-stateful-chromium',
      testMatch: [workerStatefulSpec],
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual-chromium',
      testMatch: [/(?:map|ui)-visual\.spec\.ts/],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
