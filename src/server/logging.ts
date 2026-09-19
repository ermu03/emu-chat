export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'hermes_api_key',
  'key',
  'token',
  'secret',
  'password',
  'cookie',
  'x-hermes-session-key'
]);

const FORBIDDEN_CONTENT_KEYS = new Set([
  'input',
  'content',
  'reasoning',
  'reasoning_content',
  'command',
  'preview',
  'arguments',
  'result',
  'delta',
  'text',
  'payload'
]);

export function sanitizeLogValue(key: string, val: unknown): unknown {
  const lowerKey = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lowerKey)) {
    return '[REDACTED_SECRET]';
  }
  if (FORBIDDEN_CONTENT_KEYS.has(lowerKey)) {
    if (typeof val === 'string') {
      return `[REDACTED_CONTENT: length ${val.length}]`;
    }
    return '[REDACTED_CONTENT]';
  }
  if (typeof val === 'string') {
    // Strip absolute paths
    return val.replace(/\/(?:home|Users|var|tmp|etc|usr|opt)\/[a-zA-Z0-9_\-./]+/g, '[PATH]');
  }
  if (val !== null && typeof val === 'object') {
    if (Array.isArray(val)) {
      return val.map((item, idx) => sanitizeLogValue(String(idx), item));
    }
    const cleanObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      cleanObj[k] = sanitizeLogValue(k, v);
    }
    return cleanObj;
  }
  return val;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  localRunId?: string;
  conversationId?: string;
  hermesSessionId?: string;
  upstreamStatus?: number;
  errorCode?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export class SafeLogger {
  private levelOrder: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60
  };

  constructor(private currentLevel: LogLevel = 'info') {}

  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.currentLevel];
  }

  private write(level: LogLevel, message: string, meta?: Partial<StructuredLogRecord>): void {
    if (!this.shouldLog(level)) return;

    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta?.requestId ? { requestId: meta.requestId } : {}),
      ...(meta?.localRunId ? { localRunId: meta.localRunId } : {}),
      ...(meta?.conversationId ? { conversationId: meta.conversationId } : {}),
      ...(meta?.hermesSessionId ? { hermesSessionId: meta.hermesSessionId } : {}),
      ...(meta?.upstreamStatus ? { upstreamStatus: meta.upstreamStatus } : {}),
      ...(meta?.errorCode ? { errorCode: meta.errorCode } : {}),
      ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta?.details ? { details: sanitizeLogValue('details', meta.details) as Record<string, unknown> } : {})
    };

    const serialized = JSON.stringify(record);
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(serialized + '\n');
    } else {
      process.stdout.write(serialized + '\n');
    }
  }

  trace(message: string, meta?: Partial<StructuredLogRecord>): void {
    this.write('trace', message, meta);
  }

  debug(message: string, meta?: Partial<StructuredLogRecord>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Partial<StructuredLogRecord>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Partial<StructuredLogRecord>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Partial<StructuredLogRecord>): void {
    this.write('error', message, meta);
  }

  fatal(message: string, meta?: Partial<StructuredLogRecord>): void {
    this.write('fatal', message, meta);
  }
}

export const logger = new SafeLogger(
  (process.env['LOG_LEVEL'] as LogLevel) || 'info'
);
