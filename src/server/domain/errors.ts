import { ErrorCode } from '../../shared/domain-enums.js';
import { ErrorAction, ApiErrorEnvelope } from '../../shared/api-schemas.js';

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  statusCode: number;
  retryable: boolean;
  action: ErrorAction;
  upstreamStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly action: ErrorAction;
  public readonly upstreamStatus?: number;
  public readonly details?: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.action = options.action;
    if (options.upstreamStatus !== undefined) {
      this.upstreamStatus = options.upstreamStatus;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  public toEnvelope(requestId: string): ApiErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        action: this.action,
        request_id: requestId,
        ...(this.upstreamStatus !== undefined ? { upstream_status: this.upstreamStatus } : {}),
        ...(this.details !== undefined ? { details: this.details } : {})
      }
    };
  }
}

export class InvalidRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'INVALID_REQUEST',
      message,
      statusCode: 400,
      retryable: false,
      action: 'none',
      ...(details ? { details } : {})
    });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'PAYLOAD_TOO_LARGE',
      message,
      statusCode: 413,
      retryable: false,
      action: 'none',
      ...(details ? { details } : {})
    });
  }
}

export class LocalNotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'LOCAL_NOT_FOUND',
      message,
      statusCode: 404,
      retryable: false,
      action: 'refresh_status',
      ...(details ? { details } : {})
    });
  }
}

export class HermesNotFoundError extends AppError {
  constructor(message: string, upstreamStatus: number = 404, details?: Record<string, unknown>) {
    super({
      code: 'HERMES_NOT_FOUND',
      message,
      statusCode: 404,
      retryable: false,
      action: 'refresh_status',
      upstreamStatus,
      ...(details ? { details } : {})
    });
  }
}

export class DraftConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'DRAFT_CONFLICT',
      message,
      statusCode: 409,
      retryable: false,
      action: 'resolve_conflict',
      ...(details ? { details } : {})
    });
  }
}

export class LocalConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'LOCAL_CONFLICT',
      message,
      statusCode: 409,
      retryable: false,
      action: 'refresh_status',
      ...(details ? { details } : {})
    });
  }
}

export class StateConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'STATE_CONFLICT',
      message,
      statusCode: 409,
      retryable: false,
      action: 'refresh_status',
      ...(details ? { details } : {})
    });
  }
}

export class RunActiveError extends AppError {
  constructor(message: string = 'Conversation or system has an active run', details?: Record<string, unknown>) {
    super({
      code: 'RUN_ACTIVE',
      message,
      statusCode: 409,
      retryable: false,
      action: 'refresh_status',
      ...(details ? { details } : {})
    });
  }
}

export class ApprovalNotPendingError extends AppError {
  constructor(message: string = 'Approval is not pending or has expired', details?: Record<string, unknown>) {
    super({
      code: 'APPROVAL_NOT_PENDING',
      message,
      statusCode: 409,
      retryable: false,
      action: 'refresh_status',
      ...(details ? { details } : {})
    });
  }
}

export class ReviewRequiredError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: 'REVIEW_REQUIRED',
      message,
      statusCode: 409,
      retryable: false,
      action: 'review_required',
      ...(details ? { details } : {})
    });
  }
}

export class HermesNotReadyError extends AppError {
  constructor(message: string = 'Hermes upstream is not ready', details?: Record<string, unknown>) {
    super({
      code: 'HERMES_NOT_READY',
      message,
      statusCode: 503,
      retryable: true,
      action: 'recheck',
      ...(details ? { details } : {})
    });
  }
}

export class HermesAuthFailedError extends AppError {
  constructor(message: string = 'Authentication to Hermes upstream failed', upstreamStatus?: number) {
    super({
      code: 'HERMES_AUTH_FAILED',
      message,
      statusCode: 502,
      retryable: false,
      action: 'none',
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {})
    });
  }
}

export class HermesUnavailableError extends AppError {
  constructor(message: string = 'Hermes upstream is unavailable', upstreamStatus?: number) {
    super({
      code: 'HERMES_UNAVAILABLE',
      message,
      statusCode: 502,
      retryable: true,
      action: 'reconnect',
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {})
    });
  }
}

export class HermesConflictError extends AppError {
  constructor(message: string, upstreamStatus: number = 409, details?: Record<string, unknown>) {
    super({
      code: 'HERMES_CONFLICT',
      message,
      statusCode: 409,
      retryable: false,
      action: 'refresh_status',
      upstreamStatus,
      ...(details ? { details } : {})
    });
  }
}

export class HermesTemporaryFailureError extends AppError {
  constructor(message: string = 'Hermes temporary failure', upstreamStatus?: number) {
    super({
      code: 'HERMES_TEMPORARY_FAILURE',
      message,
      statusCode: 502,
      retryable: true,
      action: 'retry',
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {})
    });
  }
}

export class HermesProtocolError extends AppError {
  constructor(message: string = 'Hermes upstream returned unexpected protocol response', details?: Record<string, unknown>) {
    super({
      code: 'HERMES_PROTOCOL_ERROR',
      message,
      statusCode: 502,
      retryable: false,
      action: 'recheck',
      ...(details ? { details } : {})
    });
  }
}

export class HermesBusyGlobalError extends AppError {
  constructor(message: string = 'Hermes server agent is busy with another run') {
    super({
      code: 'HERMES_BUSY_GLOBAL',
      message,
      statusCode: 409,
      retryable: true,
      action: 'retry'
    });
  }
}

export class DeleteUnconfirmedError extends AppError {
  constructor(message: string = 'Session deletion unconfirmed upstream; local state retained') {
    super({
      code: 'DELETE_UNCONFIRMED',
      message,
      statusCode: 503,
      retryable: true,
      action: 'refresh_status'
    });
  }
}

export class InternalError extends AppError {
  constructor(message: string = 'Internal server error', details?: Record<string, unknown>) {
    super({
      code: 'INTERNAL_ERROR',
      message,
      statusCode: 500,
      retryable: false,
      action: 'none',
      ...(details ? { details } : {})
    });
  }
}
