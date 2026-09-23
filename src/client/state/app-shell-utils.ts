import type {
  MessageItem,
  QueueItemResponse,
  QueueListResponse,
} from "../../shared/api-schemas.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function upsertQueueItem(
  current: QueueListResponse | null,
  conversationId: string,
  item: QueueItemResponse,
): QueueListResponse {
  if (!current || current.conversation_id !== conversationId) {
    return {
      object: "emu_chat.queue",
      conversation_id: conversationId,
      paused: false,
      pause_reason: null,
      data: [item],
    };
  }
  return (
    replaceQueueItem(current, item) ?? {
      object: "emu_chat.queue",
      conversation_id: conversationId,
      paused: current.paused,
      pause_reason: current.pause_reason,
      data: [...current.data, item],
    }
  );
}

export function replaceQueueItem(
  current: QueueListResponse | null,
  item: QueueItemResponse,
): QueueListResponse | null {
  if (!current || current.conversation_id !== item.conversation_id)
    return current;
  const exists = current.data.some((entry) => entry.id === item.id);
  const data = exists
    ? current.data.map((entry) => (entry.id === item.id ? item : entry))
    : [...current.data, item];
  return {
    ...current,
    data: data.sort((left, right) => left.fifo_seq - right.fifo_seq),
  };
}

export function hasPersistedQueueMessage(
  messages: MessageItem[],
  queueItem: QueueItemResponse,
): boolean {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return latestUserMessage?.content === queueItem.content;
}

export function generateBrowserUuid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("当前浏览器无法安全生成发送请求标识");
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
