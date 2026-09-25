import { describe, it, expect } from "vitest";
import {
  maskDisplaySensitiveText,
  maskSensitiveObject,
  maskToolArgumentsForDisplay,
} from "../../../src/server/display-masking.js";

describe("display-masking", () => {
  it("masks environment variable assignments in text", () => {
    expect(maskDisplaySensitiveText("TOKEN=abc ls -la")).toBe(
      "TOKEN=[已隐藏] ls -la",
    );
    expect(
      maskDisplaySensitiveText('export API_KEY="secret 123" && echo hi'),
    ).toBe('export API_KEY="[已隐藏]" && echo hi');
    expect(maskDisplaySensitiveText("foo=bar secret=xyz")).toBe(
      "foo=bar secret=[已隐藏]",
    );
  });

  it("masks CLI flags in text", () => {
    expect(maskDisplaySensitiveText("curl --api-key abc https://api.com")).toBe(
      "curl --api-key [已隐藏] https://api.com",
    );
    expect(maskDisplaySensitiveText("app --password=my-password run")).toBe(
      "app --password=[已隐藏] run",
    );
    expect(maskDisplaySensitiveText("cli --token 'my-token'")).toBe(
      "cli --token '[已隐藏]'",
    );
    expect(maskDisplaySensitiveText("cli --token=abc; echo done")).toBe(
      "cli --token=[已隐藏]; echo done",
    );
  });

  it("masks HTTP headers", () => {
    expect(
      maskDisplaySensitiveText(
        "Authorization: Bearer secret-token\nContent-Type: application/json",
      ),
    ).toBe("Authorization: [已隐藏]\nContent-Type: application/json");
    expect(maskDisplaySensitiveText("Cookie: session=123; user=emu")).toBe(
      "Cookie: [已隐藏]",
    );
    expect(
      maskDisplaySensitiveText(
        "curl -H Authorization:Bearer\\ abc --url https://example.com/path",
      ),
    ).toBe("curl -H Authorization:[已隐藏] --url https://example.com/path");
    expect(
      maskDisplaySensitiveText(
        "curl -H 'Authorization: Bearer abc' -H 'Accept: application/json' https://example.com",
      ),
    ).toBe(
      "curl -H 'Authorization: [已隐藏]' -H 'Accept: application/json' https://example.com",
    );
  });

  it("masks URL userinfo and query parameters", () => {
    expect(
      maskDisplaySensitiveText(
        "git clone https://username:secretpass@github.com/repo.git",
      ),
    ).toBe("git clone https://username:[已隐藏]@github.com/repo.git");

    expect(
      maskDisplaySensitiveText("curl https://example.com/api?token=abc&page=2"),
    ).toBe("curl https://example.com/api?token=[已隐藏]&page=2");

    expect(
      maskDisplaySensitiveText(
        "https://api.com/v1?user=emu&api_key=xyz#anchor",
      ),
    ).toBe("https://api.com/v1?user=emu&api_key=[已隐藏]#anchor");
    expect(
      maskDisplaySensitiveText(
        "curl 'https://example.com?token=abc'; echo done",
      ),
    ).toBe("curl 'https://example.com?token=[已隐藏]'; echo done");
    expect(maskDisplaySensitiveText("https://:pass@example.com/path")).toBe(
      "https://:[已隐藏]@example.com/path",
    );
  });

  it("masks sensitive JSON keys in text", () => {
    const raw = '{"token": "abc12345", "name": "emu", "password": "pass"}';
    const masked = maskDisplaySensitiveText(raw);
    expect(JSON.parse(masked)).toEqual({
      token: "[已隐藏]",
      name: "emu",
      password: "[已隐藏]",
    });
    const toolResult = JSON.stringify({
      output: "Authorization: Bearer abc\nnormal line",
    });
    expect(JSON.parse(maskDisplaySensitiveText(toolResult))).toEqual({
      output: "Authorization: [已隐藏]\nnormal line",
    });
  });

  it("masks sensitive keys in objects recursively", () => {
    const obj = {
      user: "test",
      api_key: "real-secret",
      nested: {
        password: "p1",
        other: "ok",
      },
      pass_word: "ordinary",
    };
    const masked = maskSensitiveObject(obj);
    expect(masked).toEqual({
      user: "test",
      api_key: "[已隐藏]",
      nested: {
        password: "[已隐藏]",
        other: "ok",
      },
      pass_word: "ordinary",
    });
  });

  it("masks terminal input while preserving command structure", () => {
    const result = maskToolArgumentsForDisplay("terminal", {
      command: "curl -H 'Authorization: Bearer my-token' https://api.com",
    });
    expect(result).toBe("curl -H 'Authorization: [已隐藏]' https://api.com");
  });

  it("keeps complete masked arguments for other tools", () => {
    const result = maskToolArgumentsForDisplay("read_file", {
      path: "/home/emu/projects/test.ts",
      password: "secret",
    });
    expect(JSON.parse(result!)).toEqual({
      path: "/home/emu/projects/test.ts",
      password: "[已隐藏]",
    });
  });

  it("omits malformed structured arguments", () => {
    expect(
      maskToolArgumentsForDisplay(
        "terminal",
        '{"command":"echo hi","password":"secret"',
      ),
    ).toBeUndefined();
  });
});
