import { describe, expect, it, vi } from "vitest";
import { SafeLogger, sanitizeLogValue } from "../../src/server/logging.js";

describe("SafeLogger details sanitization", () => {
  it("writes one redacted log for cycles while preserving independent shared references", () => {
    const shared = { TOKEN: "shared-secret", label: "safe" };
    const details: Record<string, unknown> = {
      TOKEN: "primary-secret",
      content: "draft",
      path: "/home/emu/private/file",
      first: shared,
      second: shared,
    };
    details.self = details;
    const array: unknown[] = [];
    array.push(array);
    details.array = array;

    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      new SafeLogger().info("sanitization test", { details });

      expect(write).toHaveBeenCalledTimes(1);
      const line = String(write.mock.calls[0]?.[0]);
      const record = JSON.parse(line) as { details: Record<string, unknown> };
      expect(record.details).toMatchObject({
        TOKEN: "[REDACTED_SECRET]",
        content: "[REDACTED_CONTENT: length 5]",
        path: "[PATH]",
        first: { TOKEN: "[REDACTED_SECRET]", label: "safe" },
        second: { TOKEN: "[REDACTED_SECRET]", label: "safe" },
        self: "[CIRCULAR]",
        array: ["[CIRCULAR]"],
      });
      expect(line).not.toContain("primary-secret");
      expect(line).not.toContain("shared-secret");
      expect(line).not.toContain("/home/emu/private/file");
    } finally {
      write.mockRestore();
    }
  });

  it("truncates deeply nested objects and arrays after the eighth level", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let level = 1; level <= 1000; level += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
      if (level === 8) {
        cursor.TOKEN = { secret: "hidden-secret" };
        cursor.payload = { text: "hidden-content" };
      }
    }

    const sanitized = sanitizeLogValue("details", deep) as Record<
      string,
      unknown
    >;
    let atLimit = sanitized;
    for (let level = 1; level <= 8; level += 1) {
      atLimit = atLimit.next as Record<string, unknown>;
    }
    expect(atLimit).toEqual({
      TOKEN: "[REDACTED_SECRET]",
      payload: "[REDACTED_CONTENT]",
      next: "[MAX_DEPTH]",
    });
    expect(JSON.stringify(sanitized)).not.toContain("hidden-secret");

    const nested: unknown[] = [];
    let current = nested;
    for (let level = 1; level <= 9; level += 1) {
      const next: unknown[] = [];
      current.push(next);
      current = next;
    }
    let sanitizedArray = sanitizeLogValue("details", nested) as unknown[];
    for (let level = 1; level <= 8; level += 1) {
      sanitizedArray = sanitizedArray[0] as unknown[];
    }
    expect(sanitizedArray[0]).toBe("[MAX_DEPTH]");
  });
});
