export const ID_PREFIXES = {
  conversation: "cv_",
  queueItem: "qi_",
  operation: "op_",
  localRun: "lr_",
  request: "rq_",
  idempotency: "ec_",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generate a UUID-backed identifier using one of the declared wire prefixes. */
export function generateId(prefix: IdPrefix): string {
  return `${prefix}${crypto.randomUUID()}`;
}

export function generateConversationId(): string {
  return generateId(ID_PREFIXES.conversation);
}

export function generateQueueItemId(): string {
  return generateId(ID_PREFIXES.queueItem);
}

export function generateOperationId(): string {
  return generateId(ID_PREFIXES.operation);
}

export function generateRunId(): string {
  return generateId(ID_PREFIXES.localRun);
}

export function generateClientRequestId(): string {
  return generateId(ID_PREFIXES.request);
}

export function generateIdempotencyKey(): string {
  return generateId(ID_PREFIXES.idempotency);
}

export function isValidPrefixedId(id: string, prefix: IdPrefix): boolean {
  if (!id.startsWith(prefix)) {
    return false;
  }
  const rawUuid = id.slice(prefix.length);
  return UUID_REGEX.test(rawUuid);
}

export function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}
