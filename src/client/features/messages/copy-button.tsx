import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({
  text,
  label,
  className = "response-copy-button",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "pending" | "copied" | "manual">(
    "idle",
  );
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    generation.current += 1;
    setState("idle");
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text]);
  useEffect(() => {
    if (state !== "manual") return;
    manualRef.current?.focus({ preventScroll: true });
    manualRef.current?.select();
  }, [state]);

  const copy = async () => {
    const request = ++generation.current;
    if (timer.current) clearTimeout(timer.current);
    setState("pending");
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (request !== generation.current) return;
      setState("copied");
      timer.current = setTimeout(() => {
        if (request === generation.current) setState("idle");
      }, 2000);
    } catch {
      if (request === generation.current) setState("manual");
    }
  };

  return (
    <div className="copy-control">
      <button
        type="button"
        className={`${className} ${state === "copied" ? "is-copied" : ""}`}
        onClick={() => void copy()}
        disabled={state === "pending" || !text}
        aria-label={state === "copied" ? "已复制" : label}
        title={label}
      >
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
        <span aria-live="polite">
          {state === "copied"
            ? "已复制"
            : state === "pending"
              ? "复制中…"
              : label}
        </span>
      </button>
      {state === "manual" && (
        <div className="copy-manual">
          <span role="status">无法自动复制，请选择以下内容并手动复制。</span>
          <textarea
            ref={manualRef}
            readOnly
            value={text}
            aria-label={`${label}：手动复制内容`}
          />
          <button type="button" onClick={() => setState("idle")}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
