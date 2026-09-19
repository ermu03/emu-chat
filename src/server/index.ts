import { loadConfig } from './config.js';
import { logger } from './logging.js';
import { buildServer } from './app.js';
import fs from 'node:fs';

async function start() {
  const config = loadConfig();

  // Ensure data directory exists
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  const server = buildServer(config);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await server.close();
      logger.info('Server closed successfully');
      process.exit(0);
    } catch (err) {
      logger.error('Error closing server', {
        details: { error: String(err) }
      });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const address = await server.listen({
      host: config.host,
      port: config.port
    });
    logger.info(`emu-chat server listening at ${address}`);
  } catch (err) {
    logger.fatal('Failed to start server', {
      details: { error: String(err) }
    });
    process.exit(1);
  }
}

if (process.env['NODE_ENV'] !== 'test') {
  start();
}
