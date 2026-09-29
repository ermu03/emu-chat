import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact } from "./artifact.js";

export type ArtifactTab = "preview" | "source";

export interface ArtifactSelection {
  artifact: Artifact;
  instanceId: number;
  initialTab: ArtifactTab;
}

/** Keeps an immutable, conversation-bound snapshot of the selected code block. */
export function useArtifactPreview(activeConversationId: string | null) {
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const nextId = useRef(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const openArtifact = useCallback(
    (artifact: Artifact, trigger: HTMLButtonElement, tab: ArtifactTab) => {
      if (artifact.conversationId !== activeConversationId) return;
      triggerRef.current = trigger;
      setSelection({ artifact, instanceId: ++nextId.current, initialTab: tab });
    },
    [activeConversationId],
  );

  const closeArtifact = useCallback(() => {
    setSelection(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected) {
      const restoreFocus = () => {
        if (trigger.isConnected) trigger.focus();
      };
      if (window.requestAnimationFrame)
        window.requestAnimationFrame(restoreFocus);
      else window.setTimeout(restoreFocus, 0);
    }
  }, []);

  useEffect(() => {
    if (
      selection &&
      selection.artifact.conversationId !== activeConversationId
    ) {
      setSelection(null);
      triggerRef.current = null;
    }
  }, [activeConversationId, selection]);

  return {
    selection:
      selection?.artifact.conversationId === activeConversationId
        ? selection
        : null,
    openArtifact,
    closeArtifact,
  };
}
