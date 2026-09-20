import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createServer, type ViteDevServer } from "vite";
import { buildServer } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/config.js";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";

const loopbackHost = "127.0.0.1";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

let fakeHermes: FakeHermesServer | undefined;
let apiServer: FastifyInstance | undefined;
let viteServer: ViteDevServer | undefined;
let dataDir: string | undefined;
let closing: Promise<void> | undefined;

async function start(): Promise<void> {
  process.chdir(projectRoot);

  const apiPort = readPort("EMU_CHAT_E2E_API_PORT", 3100);
  const webPort = readPort("EMU_CHAT_E2E_WEB_PORT", 4173);
  dataDir = await mkdtemp(path.join(tmpdir(), "emu-chat-e2e-"));

  fakeHermes = new FakeHermesServer();
  const hermesBaseUrl = await fakeHermes.start();
  const config: AppConfig = {
    host: loopbackHost,
    port: apiPort,
    dataDir,
    sqliteDbPath: path.join(dataDir, "emu-chat.sqlite"),
    hermesBaseUrl,
    hermesApiKey: "e2e-test-token",
    logLevel: "error",
    nodeEnv: "test",
    isProduction: false,
  };

  apiServer = buildServer(config);
  await apiServer.listen({ host: loopbackHost, port: apiPort });

  // Vite reads this explicit loopback target from vite.config.ts. It never
  // inherits HERMES_BASE_URL and therefore cannot reach a real Hermes server.
  process.env["EMU_CHAT_SERVER_URL"] = `http://${loopbackHost}:${apiPort}`;
  viteServer = await createServer({
    configFile: path.join(projectRoot, "vite.config.ts"),
    root: projectRoot,
    logLevel: "error",
    server: {
      host: loopbackHost,
      port: webPort,
      strictPort: true,
    },
  });
  await viteServer.listen();

  console.log(`[e2e] ready at http://${loopbackHost}:${webPort}`);
}

async function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const resources: Array<Promise<unknown>> = [];
    if (viteServer) resources.push(viteServer.close());
    if (apiServer) resources.push(apiServer.close());
    if (fakeHermes) resources.push(fakeHermes.close());
    await Promise.allSettled(resources);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  })();
  return closing;
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port number`);
  }
  return value;
}

function stop(signal: string): void {
  void close()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(`[e2e] failed to stop after ${signal}`, error);
      process.exit(1);
    });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await start();
} catch (error) {
  console.error("[e2e] failed to start local test stack", error);
  await close();
  process.exitCode = 1;
}
