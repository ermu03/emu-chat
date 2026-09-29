// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  extractArtifacts,
  MAX_ARTIFACT_BYTES,
} from "../../src/client/features/artifacts/artifact.js";

const owner = {
  conversationId: "cv_one",
  sessionId: "session_one",
  messageId: 7,
};
const fence = (language: string, source: string) =>
  `\`\`\`${language}\n${source}\n\`\`\``;

describe("artifact execution eligibility", () => {
  it("uses closed Markdown code nodes and keeps separate sources and identities", () => {
    const html =
      "<!doctype html><html><head><title>Timer</title></head><body><button>Start</button></body></html>";
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Icon</title><defs><linearGradient id="g"/></defs><circle fill="url(#g)" r="8"/></svg>';
    const markdown = [
      fence("html", html),
      fence("svg", svg),
      "\`\`\`html\n<html><script>open()",
    ].join("\n\n");
    const found = [...extractArtifacts(markdown, owner).values()];

    expect(found).toHaveLength(2);
    expect(
      found.map((artifact) => [artifact.kind, artifact.title, artifact.source]),
    ).toEqual([
      ["html", "Timer", html],
      ["svg", "Icon", svg],
    ]);
    expect(found[0]?.key).not.toBe(found[1]?.key);
    expect(found[0]).toMatchObject(owner);
  });

  it("does not admit fragments, plain XML, unclosed fences, declarations, or oversized code", () => {
    const invalidSvg =
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>';
    const markdown = [
      fence("html", "<div>fragment</div>"),
      fence("xml", "<note>plain XML</note>"),
      fence("svg", invalidSvg),
      fence("html", `<html>${"x".repeat(MAX_ARTIFACT_BYTES + 1)}</html>`),
      "\`\`\`html\n<html><body>unfinished</body></html>",
    ].join("\n\n");
    const found = [...extractArtifacts(markdown, owner).values()];

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "svg", previewable: false });
  });
});
