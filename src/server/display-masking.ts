/**
 * Display data masking for tool cards, API messages, and SSE events.
 *
 * Replaces credentials in JSON keys, environment variable assignments,
 * CLI options, HTTP headers, and URL query params/userinfo with "[已隐藏]".
 */

const TARGET_KEY_NAMES = [
  "token",
  "api_key",
  "api-key",
  "apikey",
  "password",
  "secret",
  "cookie",
  "authorization",
];

const MASK_PLACEHOLDER = "[已隐藏]";

function maskedArgumentValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote
    ? `${quote}${MASK_PLACEHOLDER}${quote}`
    : MASK_PLACEHOLDER;
}

// Regex for environment variable assignments: e.g. TOKEN=xyz, API_KEY="secret", export PASSWORD='abc'
// Exclude URL query params via negative lookbehind (?<![?&])
const ENV_VAR_REGEX = new RegExp(
  `(?<![?&])\\b(export[ \\t]+)?((?:${TARGET_KEY_NAMES.join("|")}))=("[^"]*"|'[^']*'|[^\\s;&|]+)`,
  "gi",
);

// Regex for CLI flags: e.g. --token xyz, --token=xyz, --api-key="xyz"
const CLI_FLAG_REGEX = new RegExp(
  `(--(?:${TARGET_KEY_NAMES.join("|")}))(?:=("[^"]*"|'[^']*'|[^\\s;&|]+)|[ \\t]+("[^"]*"|'[^']*'|[^\\s;&|]+))`,
  "gi",
);

// Header values may be quoted shell arguments, unquoted -H arguments, or full lines.
// Keep the surrounding command intact instead of consuming everything after the colon.
const QUOTED_HTTP_HEADER_REGEX = new RegExp(
  `(['"])((?:${TARGET_KEY_NAMES.join("|")})[ \\t]*:[ \\t]*)([^'"\\r\\n]*)\\1`,
  "gi",
);
const CLI_HTTP_HEADER_REGEX = new RegExp(
  `((?:-H|--header)[ \\t]+)((?:${TARGET_KEY_NAMES.join("|")})[ \\t]*:[ \\t]*)((?:\\\\[ \\t]|[^\\s'";&|])+)`,
  "gi",
);
const LINE_HTTP_HEADER_REGEX = new RegExp(
  `(^|\\r?\\n)([ \\t]*(?:${TARGET_KEY_NAMES.join("|")})[ \\t]*:[ \\t]*)([^\\r\\n]+)`,
  "gi",
);

// Regex for URLs containing password in userinfo: http://user:pass@host
const URL_USERINFO_PASSWORD_REGEX =
  /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@:]*:)([^\s/@]+)(@[^\s/]+)/gi;

// Regex for URL query parameters: ?token=abc or &api_key=123
const URL_QUERY_PARAM_REGEX = new RegExp(
  `([?&](?:${TARGET_KEY_NAMES.join("|")})=)([^&#\\s'";|)]+)`,
  "gi",
);

/**
 * Checks if a key name matches any of the target sensitive credential names.
 */
function isSensitiveKey(key: string): boolean {
  return TARGET_KEY_NAMES.includes(key.toLowerCase());
}

/**
 * Masks sensitive values in a JavaScript object or primitive recursively.
 */
export function maskSensitiveObject<T>(val: T): T {
  if (typeof val === "string") {
    return maskDisplaySensitiveText(val) as unknown as T;
  }
  if (val === null || typeof val !== "object") {
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => maskSensitiveObject(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      result[k] = MASK_PLACEHOLDER;
    } else if (typeof v === "object" && v !== null) {
      result[k] = maskSensitiveObject(v);
    } else if (typeof v === "string") {
      result[k] = maskDisplaySensitiveText(v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

/**
 * Masks sensitive patterns in free-form text (commands, stdout/stderr, URL, headers, etc.).
 */
export function maskDisplaySensitiveText(text: string): string {
  if (!text) return text;

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === "object") {
        return JSON.stringify(
          maskSensitiveObject(value),
          null,
          text.includes("\n") ? 2 : undefined,
        );
      }
    } catch {
      // Incomplete or free-form output continues through the text rules below.
    }
  }

  let masked = text;

  // 1. HTTP headers, preserving unrelated flags and arguments on the same line.
  masked = masked.replace(
    QUOTED_HTTP_HEADER_REGEX,
    (_match, quote: string, key: string) =>
      `${quote}${key}${MASK_PLACEHOLDER}${quote}`,
  );
  masked = masked.replace(
    CLI_HTTP_HEADER_REGEX,
    (_match, option: string, key: string) =>
      `${option}${key}${MASK_PLACEHOLDER}`,
  );
  masked = masked.replace(
    LINE_HTTP_HEADER_REGEX,
    (_match, lineStart: string, key: string) =>
      `${lineStart}${key}${MASK_PLACEHOLDER}`,
  );

  // 2. Environment variable assignments (e.g. TOKEN=xyz, export API_KEY="abc")
  masked = masked.replace(
    ENV_VAR_REGEX,
    (_match, exp: string | undefined, key: string, value: string) =>
      `${exp || ""}${key}=${maskedArgumentValue(value)}`,
  );

  // 3. CLI options (e.g. --token=xyz, --api-key abc)
  masked = masked.replace(
    CLI_FLAG_REGEX,
    (_match, flag: string, equalsVal?: string, spaceVal?: string) => {
      if (equalsVal !== undefined) {
        return `${flag}=${maskedArgumentValue(equalsVal)}`;
      }
      if (spaceVal !== undefined) {
        return `${flag} ${maskedArgumentValue(spaceVal)}`;
      }
      return `${flag} ${MASK_PLACEHOLDER}`;
    },
  );

  // 4. URL Userinfo password (http://user:password@host)
  masked = masked.replace(
    URL_USERINFO_PASSWORD_REGEX,
    (_match, prefix: string, _pass: string, suffix: string) =>
      `${prefix}${MASK_PLACEHOLDER}${suffix}`,
  );

  // 5. URL Query parameters (?token=abc&password=123)
  masked = masked.replace(
    URL_QUERY_PARAM_REGEX,
    (_match, prefix: string) => `${prefix}${MASK_PLACEHOLDER}`,
  );

  // 6. JSON strings embedded in text (e.g. "password":"xyz")
  const JSON_KEY_VAL_REGEX = new RegExp(
    `("(${TARGET_KEY_NAMES.join("|")})"\\s*:\\s*)("[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'|[^,}\\s]+)`,
    "gi",
  );
  masked = masked.replace(
    JSON_KEY_VAL_REGEX,
    (_match, prefix: string) => `${prefix}"${MASK_PLACEHOLDER}"`,
  );

  return masked;
}

/**
 * Returns complete masked invocation arguments for the expanded tool card.
 * Malformed structured arguments fall back to displaying the tool name alone.
 */
export function maskToolArgumentsForDisplay(
  toolName: string,
  rawArgs: unknown,
): string | undefined {
  let parsed: unknown = rawArgs;

  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return undefined;
      }
    } else {
      parsed = trimmed;
    }
  }

  // Handle case where parsed is a JSON object
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const maskedObj = maskSensitiveObject(
      parsed as Record<string, unknown>,
    ) as Record<string, unknown>;
    return toolName === "terminal" && typeof maskedObj.command === "string"
      ? maskedObj.command
      : JSON.stringify(maskedObj, null, 2);
  }

  if (typeof parsed === "string") {
    return maskDisplaySensitiveText(parsed);
  }

  return undefined;
}
