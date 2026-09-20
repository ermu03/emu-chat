import { loadConfig } from "./config.js";
import { logger } from "./logging.js";
import { buildServer } from "./app.js";
import fs from "node:fs";
import path from "node:path";

async function start() {
  const envFile = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  const config = loadConfig();

  // Local control data can contain drafts and recovery payloads.
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(config.dataDir, 0o700);
  } catch {
    logger.warn(
      "Unable to apply restrictive permissions to the data directory",
    );
  }

  const server = buildServer(config);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await server.close();
      logger.info("Server closed successfully");
      process.exit(0);
    } catch (err) {
      logger.error("Error closing server", {
        details: { error: String(err) },
      });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    const address = await server.listen({
      host: config.host,
      port: config.port,
    });
    logger.info(`emu-chat server listening at ${address}`);
  } catch (err) {
    logger.fatal("Failed to start server", {
      details: { error: String(err) },
    });
    process.exit(1);
  }
}

if (process.env["NODE_ENV"] !== "test") {
  start();
}
