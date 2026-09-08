import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
export default defineConfig({
  testDir: './tests/ui', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4328', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node server/index.mjs --demo', url: 'http://127.0.0.1:4328/api/state', reuseExistingServer: false,
    env: { PORT: '4328', WORKBENCH_DATA_DIR: path.join(os.tmpdir(), `workbench-ui-${process.pid}`) } },
});
