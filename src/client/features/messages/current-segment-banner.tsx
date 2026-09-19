import React from 'react';
import type { ConversationDetailResponse } from '../../../shared/api-schemas.js';

export interface CurrentSegmentBannerProps {
  conversation: ConversationDetailResponse | null;
}

export const CurrentSegmentBanner: React.FC<CurrentSegmentBannerProps> = ({ conversation }) => {
  if (!conversation) return null;

  return (
    <div className="px-4 py-2 bg-neutral-50 dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center space-x-2">
        <span className="font-semibold text-neutral-700 dark:text-neutral-300">
          当前片段:
        </span>
        <code className="font-mono text-neutral-800 dark:text-neutral-200 bg-neutral-200/50 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
          {conversation.hermes_session_id}
        </code>
        {conversation.parent_session_id && (
          <span className="text-neutral-400">
            (分叉自: <code className="font-mono">{conversation.parent_session_id.slice(0, 12)}...</code>)
          </span>
        )}
      </div>

      <div className="text-[10px] text-neutral-400 italic">
        Hermes 为唯一真理源。为防止上下文幻觉，本系统不拼接上级片段历史。
      </div>
    </div>
  );
};
