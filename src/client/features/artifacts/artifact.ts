import type {
  Blockquote,
  Code,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { parse as parseHtml, parseFragment as parseHtmlFragment } from "parse5";

export type ArtifactKind = "html" | "svg";

export interface Artifact {
  readonly key: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly messageId: number;
  readonly blockIndex: number;
  readonly contentHash: string;
  readonly kind: ArtifactKind;
  readonly origin: "fence" | "raw-svg" | "raw-html";
  readonly title: string;
  readonly filename: string;
  readonly source: string;
  readonly previewable: boolean;
  readonly sizingWarning?: string;
}

export interface ArtifactSource {
  conversationId: string;
  sessionId: string;
  messageId: number;
}

// A larger code block stays a normal Markdown code block instead of creating
// another document parser and runnable browsing context.
export const MAX_ARTIFACT_BYTES = 256 * 1024;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function extractArtifacts(
  markdown: string,
  source: ArtifactSource,
): Map<number, Artifact> {
  const artifacts = new Map<number, Artifact>();
  if (
    !markdown.includes("```") &&
    !markdown.includes("~~~") &&
    !/<[a-z][\w:-]*\b/i.test(markdown)
  )
    return artifacts;
  const tree = parser.parse(markdown) as Root;
  const blocks: {
    offset: number;
    source: string;
    language: string | undefined;
    origin: Artifact["origin"];
  }[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "code") {
      const code = node as Code;
      const offset = code.position?.start.offset;
      const end = code.position?.end.offset;
      if (
        offset === undefined ||
        end === undefined ||
        !isClosedFence(markdown.slice(offset, end))
      )
        return;
      blocks.push({
        offset,
        source: code.value,
        language: code.lang?.toLowerCase(),
        origin: "fence",
      });
      return;
    }
    if (node.type === "html") {
      const offset = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (offset === undefined || end === undefined) return;
      if (/^<svg\b/i.test(node.value))
        blocks.push({
          offset,
          source: markdown.slice(offset, end),
          language: "svg",
          origin: "raw-svg",
        });
      else {
        const raw = markdown.slice(offset, end);
        const completeDocument =
          raw.length <= MAX_ARTIFACT_BYTES && isCompleteHtml(raw);
        const fragmentEnd = completeDocument
          ? raw.length
          : completeHtmlFragmentEnd(raw.slice(0, MAX_ARTIFACT_BYTES + 1));
        if (
          fragmentEnd !== null &&
          !raw.slice(fragmentEnd).trimStart().startsWith("<")
        )
          blocks.push({
            offset,
            source: raw.slice(0, fragmentEnd),
            language: "html",
            origin: "raw-html",
          });
      }
      return;
    }
    if (node.type === "paragraph") {
      for (const span of findInlineSvgSpans(node))
        blocks.push({
          offset: span.start,
          source: markdown.slice(span.start, span.end),
          language: "svg",
          origin: "raw-svg",
        });
      return;
    }
    if ("children" in node && Array.isArray(node.children))
      for (const child of node.children) visit(child);
  };
  visit(tree);
  blocks.sort((left, right) => left.offset - right.offset);
  for (const [index, block] of blocks.entries()) {
    if (new TextEncoder().encode(block.source).byteLength > MAX_ARTIFACT_BYTES)
      continue;
    const candidate = classifyArtifact(block.language, block.source);
    if (!candidate || (block.origin !== "fence" && !candidate.previewable))
      continue;
    const contentHash = hashSource(block.source);
    const title = candidate.title.slice(0, 120);
    artifacts.set(block.offset, {
      key: `${source.conversationId}:${source.sessionId}:${source.messageId}:${index}:${contentHash}`,
      ...source,
      blockIndex: index,
      contentHash,
      kind: candidate.kind,
      origin: block.origin,
      title,
      filename: safeFilename(title, candidate.kind),
      source: block.source,
      previewable: candidate.previewable,
      ...(candidate.sizingWarning
        ? { sizingWarning: candidate.sizingWarning }
        : {}),
    });
  }
  return artifacts;
}

function findInlineSvgSpans(
  paragraph: Paragraph,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const children = paragraph.children;
  for (let index = 0; index < children.length; index++) {
    const opening = children[index];
    if (opening?.type !== "html" || !/^<svg\b/i.test(opening.value)) continue;
    const start = opening.position?.start.offset;
    if (start === undefined) continue;
    let depth = /\/\s*>$/.test(opening.value) ? 0 : 1;
    let end = depth === 0 ? opening.position?.end.offset : undefined;
    for (
      let cursor = index + 1;
      depth > 0 && cursor < children.length;
      cursor++
    ) {
      const child = children[cursor];
      if (child?.type !== "html") continue;
      if (/^<svg\b/i.test(child.value) && !/\/\s*>$/.test(child.value)) depth++;
      else if (/^<\/svg\s*>$/i.test(child.value)) depth--;
      if (depth === 0) {
        end = child.position?.end.offset;
        index = cursor;
      }
    }
    if (end !== undefined) spans.push({ start, end });
  }
  return spans;
}

// Render validated, unfenced artifacts as code blocks at their original
// location. ReactMarkdown still escapes raw HTML when none is admitted.
export function remarkRawArtifacts(artifacts: Map<number, Artifact>) {
  return (tree: Root) => {
    const visit = (parent: Root | Blockquote | ListItem) => {
      const children = parent.children as RootContent[];
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (!child) continue;
        if (child.type === "html") {
          const artifact = artifacts.get(child.position?.start.offset ?? -1);
          if (artifact && artifact.origin !== "fence") {
            const remainder = child.value.slice(artifact.source.length);
            const code: Code = {
              type: "code",
              lang: artifact.kind,
              value: artifact.source,
              position: child.position
                ? {
                    start: child.position.start,
                    end: advancePoint(child.position.start, artifact.source),
                  }
                : undefined,
            };
            if (remainder) {
              children.splice(index, 1, code, {
                type: "html",
                value: remainder,
                position: child.position
                  ? {
                      start: code.position!.end,
                      end: child.position.end,
                    }
                  : undefined,
              });
              index++;
            } else children[index] = code;
          }
        } else if (child.type === "paragraph") {
          const replacements = splitRawSvgParagraph(child, artifacts);
          if (replacements) {
            children.splice(index, 1, ...replacements);
            index += replacements.length - 1;
          }
        } else if (child.type === "blockquote" || child.type === "listItem") {
          visit(child);
        } else if (child.type === "list") {
          for (const item of child.children) visit(item);
        }
      }
    };
    visit(tree);
  };
}

function advancePoint(
  start: NonNullable<Code["position"]>["start"],
  source: string,
): NonNullable<Code["position"]>["end"] {
  let line = start.line;
  let column = start.column;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column, offset: (start.offset ?? 0) + source.length };
}

function splitRawSvgParagraph(
  paragraph: Paragraph,
  artifacts: Map<number, Artifact>,
): RootContent[] | null {
  const replacements: RootContent[] = [];
  let pending: PhrasingContent[] = [];
  const flush = () => {
    if (!pending.length) return;
    const first = pending[0];
    const last = pending.at(-1);
    replacements.push({
      ...paragraph,
      children: pending,
      position:
        first?.position && last?.position
          ? { start: first.position.start, end: last.position.end }
          : paragraph.position,
    });
    pending = [];
  };
  for (let index = 0; index < paragraph.children.length; index++) {
    const child = paragraph.children[index];
    if (!child) continue;
    const artifact = artifacts.get(child.position?.start.offset ?? -1);
    if (artifact?.origin !== "raw-svg") {
      pending.push(child);
      continue;
    }
    const end = (child.position?.start.offset ?? 0) + artifact.source.length;
    const lastIndex = paragraph.children.findIndex(
      (item, candidateIndex) =>
        candidateIndex >= index && item.position?.end.offset === end,
    );
    if (lastIndex < index) {
      pending.push(child);
      continue;
    }
    flush();
    replacements.push({
      type: "code",
      lang: "svg",
      value: artifact.source,
      position:
        child.position && paragraph.children[lastIndex]?.position
          ? {
              start: child.position.start,
              end: paragraph.children[lastIndex]!.position!.end,
            }
          : undefined,
    });
    index = lastIndex;
  }
  flush();
  return replacements.some((node) => node.type === "code")
    ? replacements
    : null;
}

function isClosedFence(segment: string): boolean {
  const lines = segment.trimEnd().split(/\r?\n/);
  if (lines.length < 2) return false;
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(lines[0] ?? "");
  if (!opening) return false;
  const fence = opening[1];
  if (!fence) return false;
  const closing = (lines.at(-1) ?? "").trim();
  return (
    closing.length >= fence.length &&
    [...closing].every((char) => char === fence[0])
  );
}

function classifyArtifact(
  language: string | undefined,
  source: string,
): {
  kind: ArtifactKind;
  title: string;
  previewable: boolean;
  sizingWarning?: string;
} | null {
  if (language !== "html" && language !== "svg" && language !== "xml")
    return null;

  // XML parsing is inert. A complete SVG root is required even in an html fence.
  if (
    language === "svg" ||
    language === "xml" ||
    /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source)
  ) {
    const svg = parseSvg(source);
    if (svg)
      return {
        kind: "svg",
        title: svg.title,
        previewable: true,
        ...(svg.hasSizing
          ? {}
          : {
              sizingWarning:
                "SVG 缺少有效 viewBox 或宽高，浏览器将使用默认尺寸。",
            }),
      };
    return language === "svg"
      ? { kind: "svg", title: "SVG 图标", previewable: false }
      : null;
  }

  if (language !== "html") return null;
  const completeDocument = isCompleteHtml(source);
  const fragmentEnd = completeDocument ? null : completeHtmlFragmentEnd(source);
  if (
    !completeDocument &&
    (fragmentEnd === null || source.slice(fragmentEnd).trim())
  )
    return null;
  return {
    kind: "html",
    title: (completeDocument && parseHtmlTitle(source)) || "HTML 成果",
    previewable: true,
  };
}

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  childNodes?: HtmlNode[];
  value?: string;
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    endTag?: { startOffset: number };
  };
}

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function completeHtmlFragmentEnd(source: string): number | null {
  const errors: string[] = [];
  const fragment = parseHtmlFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => errors.push(error.code),
  }) as HtmlNode;
  if (errors.length) return null;
  const first = fragment.childNodes?.find(
    (node) => node.nodeName !== "#text" || Boolean(node.value?.trim()),
  );
  const location = first?.sourceCodeLocation;
  if (
    !first?.tagName ||
    !location?.endTag ||
    source.slice(0, location.startOffset).trim() ||
    first.tagName === "html" ||
    first.tagName === "head" ||
    first.tagName === "body" ||
    !hasExplicitHtmlClosures(first, source)
  )
    return null;
  return location.endOffset;
}

function hasExplicitHtmlClosures(node: HtmlNode, source: string): boolean {
  if (node.tagName && node.sourceCodeLocation) {
    const location = node.sourceCodeLocation;
    if (
      !VOID_HTML_ELEMENTS.has(node.tagName) &&
      !location.endTag &&
      !source.slice(location.startOffset, location.endOffset).endsWith("/>")
    )
      return false;
  }
  return (node.childNodes ?? []).every((child) =>
    hasExplicitHtmlClosures(child, source),
  );
}

function parseHtmlTitle(source: string): string {
  // parse5 does not create browser elements or start image/frame requests.
  const document = parseHtml(source) as HtmlNode;
  const findHead = (node: HtmlNode): HtmlNode | null => {
    if (node.nodeName === "head") return node;
    for (const child of node.childNodes ?? []) {
      const found = findHead(child);
      if (found) return found;
    }
    return null;
  };
  const title = findHead(document)?.childNodes?.find(
    (child) => child.nodeName === "title",
  );
  return (
    title?.childNodes
      ?.map((child) => child.value ?? "")
      .join("")
      .trim() ?? ""
  );
}

function isCompleteHtml(source: string): boolean {
  return /^\s*(?:<!doctype\s+html(?:\s+[^>]*)?>\s*)?<html(?:\s+[^>]*)?>[\s\S]*<\/html>\s*$/i.test(
    source,
  );
}

function parseSvg(
  source: string,
): { title: string; hasSizing: boolean } | null {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || /<\?(?!xml\s)/i.test(source))
    return null;
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE ||
    document.getElementsByTagName("parsererror").length > 0
  )
    return null;
  const title = Array.from(root.children).find(
    (child) =>
      child.localName === "title" && child.namespaceURI === SVG_NAMESPACE,
  );
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasViewBox =
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    (viewBox[2] ?? 0) > 0 &&
    (viewBox[3] ?? 0) > 0;
  const hasDimensions = [
    root.getAttribute("width"),
    root.getAttribute("height"),
  ].every((value) => value !== null && parseFloat(value) > 0);
  return {
    title: title?.textContent?.trim() || "SVG 图标",
    hasSizing: Boolean(hasViewBox || hasDimensions),
  };
}

function safeFilename(title: string, kind: ArtifactKind): string {
  const stem = title
    .replace(/[\\/\x00-\x1f<>:"|?*]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  return `${stem || (kind === "html" ? "html-artifact" : "svg-icon")}.${kind}`;
}

function hashSource(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function downloadArtifact(artifact: Artifact): void {
  const url = URL.createObjectURL(
    new Blob([artifact.source], {
      type:
        artifact.kind === "html"
          ? "text/html;charset=utf-8"
          : "image/svg+xml;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = artifact.filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
