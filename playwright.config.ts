import { defineConfig } from "@playwright/test";

const webPort = readPort("EMU_CHAT_E2E_WEB_PORT", 4173);
const apiPort = readPort("EMU_CHAT_E2E_API_PORT", 3100);
const webUrl = `http://127.0.0.1:${webPort}`;
const chromiumExecutablePath = process.env["EMU_CHAT_E2E_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  outputDir: "test-results/e2e",
  reporter: "list",
  use: {
    baseURL: webUrl,
    browserName: "chromium",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...(chromiumExecutablePath
      ? { launchOptions: { executablePath: chromiumExecutablePath } }
      : {}),
  },
  webServer: {
    command: "./node_modules/.bin/tsx tests/e2e/start-local-stack.ts",
    url: webUrl,
    timeout: 45_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: "test",
      EMU_CHAT_E2E_WEB_PORT: String(webPort),
      EMU_CHAT_E2E_API_PORT: String(apiPort),
    },
  },
});

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port number`);
  }
  return value;
}
