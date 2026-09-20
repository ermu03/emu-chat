import type { MessageItem } from "../../../shared/api-schemas.js";

export function getRenderableMessages(messages: MessageItem[]): MessageItem[] {
  return messages.filter(
    (message) =>
      Boolean(message.content.trim()) ||
      Boolean(message.tool_name) ||
      Boolean(message.reasoning?.trim()),
  );
}

export function getToolResultContent(content: string): string {
  const fallback = content.trim() || "没有返回内容";

  try {
    const payload: unknown = JSON.parse(content);
    if (!isRecord(payload)) return fallback;

    const output = typeof payload.output === "string" ? payload.output : "";
    const error =
      typeof payload.error === "string" && payload.error.trim()
        ? `错误：${payload.error.trim()}`
        : getExitCodeFailure(payload.exit_code);

    return [output.trim(), error].filter(Boolean).join("\n\n") || fallback;
  } catch {
    return fallback;
  }
}

function getExitCodeFailure(exitCode: unknown): string {
  return typeof exitCode === "number" && exitCode !== 0
    ? `工具执行失败（退出码 ${exitCode}）`
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
