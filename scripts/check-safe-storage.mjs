import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-crypto-check-'));
let desktop;
try {
  const env = { ...process.env, BOAN_BACKGROUND_TEST: '1', BOAN_USER_DATA: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.BOAN_TEST_EXECUTABLE;
  desktop = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [path.resolve('.')]), '--enable-logging=stderr'], env, timeout: 30000 });
  desktop.process().stderr.on('data', data => {
    for (const line of data.toString().split('\n')) if (/keychain|os_crypt|SecItem/i.test(line)) console.log(line);
  });
  await desktop.firstWindow();
  console.log(await desktop.evaluate(async ({ safeStorage }) => {
    const result = {};
    const sample = 'boan-public-encryption-test';
    try {
      result.asyncAvailable = await safeStorage.isAsyncEncryptionAvailable();
      const encrypted = await safeStorage.encryptStringAsync(sample);
      result.asyncRoundTrip = (await safeStorage.decryptStringAsync(encrypted)).result === sample;
    } catch (e) { result.asyncError = e.message; }
    try {
      result.syncAvailable = safeStorage.isEncryptionAvailable();
      const encrypted = safeStorage.encryptString(sample);
      result.syncRoundTrip = safeStorage.decryptString(encrypted) === sample;
    } catch (e) { result.syncError = e.message; }
    return result;
  }));
} finally {
  await desktop?.close();
  await fs.rm(dir, { recursive: true, force: true });
}
