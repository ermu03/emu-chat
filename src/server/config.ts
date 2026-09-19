import { z } from 'zod';
import path from 'node:path';

const ConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(3000),
  dataDir: z.string().default('./data'),
  hermesBaseUrl: z.string().url().default('http://127.0.0.1:8642'),
  hermesApiKey: z.string().default(''),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  nodeEnv: z.string().default('development')
});

export type AppConfig = {
  host: string;
  port: number;
  dataDir: string;
  sqliteDbPath: string;
  hermesBaseUrl: string;
  hermesApiKey: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  nodeEnv: string;
  isProduction: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.parse({
    host: env['EMU_CHAT_HOST'],
    port: env['EMU_CHAT_PORT'],
    dataDir: env['EMU_CHAT_DATA_DIR'],
    hermesBaseUrl: env['HERMES_BASE_URL'],
    hermesApiKey: env['HERMES_API_KEY'],
    logLevel: env['LOG_LEVEL'],
    nodeEnv: env['NODE_ENV']
  });

  const resolvedDataDir = path.resolve(process.cwd(), parsed.dataDir);
  const sqliteDbPath = path.join(resolvedDataDir, 'emu-chat.sqlite');

  return {
    host: parsed.host,
    port: parsed.port,
    dataDir: resolvedDataDir,
    sqliteDbPath,
    hermesBaseUrl: parsed.hermesBaseUrl.replace(/\/+$/, ''),
    hermesApiKey: parsed.hermesApiKey,
    logLevel: parsed.logLevel,
    nodeEnv: parsed.nodeEnv,
    isProduction: parsed.nodeEnv === 'production'
  };
}
