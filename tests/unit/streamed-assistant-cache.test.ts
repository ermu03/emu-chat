import { describe, expect, it } from "vitest";
import { StreamedAssistantCache } from "../../src/client/features/messages/streamed-assistant-cache.js";

describe("StreamedAssistantCache", () => {
  it("keeps partial text for a run and ignores replayed events", () => {
    const cache = new StreamedAssistantCache();

    expect(cache.append("lr_1", 4, "Hello")).toBe("Hello");
    expect(cache.append("lr_1", 4, "Hello")).toBeNull();
    expect(cache.append("lr_1", 5, " world")).toBe("Hello world");
    expect(cache.get("lr_1")).toBe("Hello world");
  });

  it("keeps streamed text isolated by run and clears terminal runs", () => {
    const cache = new StreamedAssistantCache();

    cache.append("lr_a", 1, "A");
    cache.append("lr_b", 1, "B");
    cache.clear("lr_a");

    expect(cache.get("lr_a")).toBe("");
    expect(cache.get("lr_b")).toBe("B");
  });
});
