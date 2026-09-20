import { describe, expect, it } from "vitest";
import { ConversationViewCache } from "../../src/client/features/conversations/conversation-view-cache.js";

describe("ConversationViewCache", () => {
  it("returns the cached view and refreshes its LRU position", () => {
    const cache = new ConversationViewCache<string>(2);
    cache.set("cv_a", "A");
    cache.set("cv_b", "B");

    expect(cache.get("cv_a")).toBe("A");
    cache.set("cv_c", "C");

    expect(cache.get("cv_a")).toBe("A");
    expect(cache.get("cv_b")).toBeUndefined();
    expect(cache.get("cv_c")).toBe("C");
  });

  it("replaces and removes an individual conversation view", () => {
    const cache = new ConversationViewCache<number>();
    cache.set("cv_a", 1);
    cache.set("cv_a", 2);
    cache.delete("cv_a");

    expect(cache.get("cv_a")).toBeUndefined();
  });
});
