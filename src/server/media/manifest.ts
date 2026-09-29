import { createHash } from "node:crypto";
import type { AttachmentRef } from "../../shared/media-schemas.js";

export const DEFAULT_IMAGE_PROMPT = "请描述这张图片。";
const START = "\n\n<emu-media-input-v1>\n";
const END = "\n</emu-media-input-v1>";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function makeMediaRunInput(input: {
  scopeId: string;
  operationId: string;
  sessionId: string;
  userText: string;
  attachments: AttachmentRef[];
}): { runInput: string; userTextSha256: string; runInputSha256: string } {
  const userTextSha256 = sha256(input.userText);
  const promptSource = input.userText.length > 0 ? "user" : "default";
  const prefix =
    promptSource === "default" ? DEFAULT_IMAGE_PROMPT : input.userText;
  const payload = {
    asset_ids: input.attachments.map((item) => item.asset_id),
    operation_id: input.operationId,
    prompt_source: promptSource,
    scope_id: input.scopeId,
    session_id: input.sessionId,
    user_text_sha256: userTextSha256,
    version: 1,
  };
  const runInput = prefix + START + JSON.stringify(payload) + END;
  return { runInput, userTextSha256, runInputSha256: sha256(runInput) };
}

export function parseMediaRunInput(runInput: string): {
  scopeId: string;
  operationId: string;
  sessionId: string;
  assetIds: string[];
  displayText: string;
  userTextSha256: string;
  runInputSha256: string;
} | null {
  if (!runInput.endsWith(END)) return null;
  const start = runInput.lastIndexOf(START);
  if (start < 0) return null;
  const prefix = runInput.slice(0, start);
  const raw = runInput.slice(start + START.length, -END.length);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const keys = [
    "asset_ids",
    "operation_id",
    "prompt_source",
    "scope_id",
    "session_id",
    "user_text_sha256",
    "version",
  ];
  if (
    JSON.stringify(
      Object.fromEntries(keys.map((key) => [key, payload[key]])),
    ) !== raw
  )
    return null;
  if (
    payload["version"] !== 1 ||
    (payload["prompt_source"] !== "user" &&
      payload["prompt_source"] !== "default") ||
    typeof payload["scope_id"] !== "string" ||
    !/^cv_[A-Za-z0-9_-]+$/.test(payload["scope_id"]) ||
    typeof payload["operation_id"] !== "string" ||
    !/^op_[A-Za-z0-9_-]+$/.test(payload["operation_id"]) ||
    typeof payload["session_id"] !== "string" ||
    typeof payload["user_text_sha256"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload["user_text_sha256"]) ||
    !Array.isArray(payload["asset_ids"]) ||
    payload["asset_ids"].length < 1 ||
    payload["asset_ids"].length > 4 ||
    payload["asset_ids"].some(
      (id: unknown) =>
        typeof id !== "string" || !/^asset_[A-Za-z0-9_-]+$/.test(id),
    ) ||
    new Set(payload["asset_ids"]).size !== payload["asset_ids"].length
  )
    return null;
  if (payload["prompt_source"] === "default" && prefix !== DEFAULT_IMAGE_PROMPT)
    return null;
  const originalText = payload["prompt_source"] === "default" ? "" : prefix;
  if (sha256(originalText) !== payload["user_text_sha256"]) return null;
  return {
    scopeId: payload["scope_id"],
    operationId: payload["operation_id"],
    sessionId: payload["session_id"],
    assetIds: payload["asset_ids"] as string[],
    displayText: originalText,
    userTextSha256: payload["user_text_sha256"],
    runInputSha256: sha256(runInput),
  };
}
