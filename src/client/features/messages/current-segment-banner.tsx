import React, { useState } from "react";
import { Info } from "lucide-react";
import type { ConversationDetailResponse } from "../../../shared/api-schemas.js";

export interface CurrentSegmentBannerProps {
  conversation: ConversationDetailResponse | null;
}

export const CurrentSegmentBanner: React.FC<CurrentSegmentBannerProps> = ({
  conversation,
}) => {
  const [open, setOpen] = useState(false);
  if (!conversation) return null;

  return (
    <div className="segment-details">
      <button
        type="button"
        className={`toolbar-button ${open ? "active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="查看会话信息"
        title="会话信息"
      >
        <Info size={14} strokeWidth={1.8} />
        信息
      </button>
      {open && (
        <div className="segment-popover">
          <h3>当前会话</h3>
          <div className="segment-popover-row">
            <span>Hermes session</span>
            <code title={conversation.hermes_session_id}>
              {conversation.hermes_session_id}
            </code>
          </div>
          {conversation.parent_session_id && (
            <div className="segment-popover-row">
              <span>分叉自</span>
              <code title={conversation.parent_session_id}>
                {conversation.parent_session_id}
              </code>
            </div>
          )}
          <div className="segment-popover-row">
            <span>消息数</span>
            <span>{conversation.message_count}</span>
          </div>
        </div>
      )}
    </div>
  );
};
