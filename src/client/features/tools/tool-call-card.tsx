import React, { useState } from 'react';

export interface ToolCallCardProps {
  toolCallId: string;
  name: string;
  argumentsText: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  resultText?: string;
  errorText?: string;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({
  toolCallId,
  name,
  argumentsText,
  status,
  resultText,
  errorText
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  let parsedArgs: string = argumentsText;
  try {
    parsedArgs = JSON.stringify(JSON.parse(argumentsText), null, 2);
  } catch {
    // 保持原文
  }

  const getStatusBadge = () => {
    switch (status) {
      case 'pending':
        return <span style={{ color: '#eab308' }}>等待执行</span>;
      case 'running':
        return <span style={{ color: '#3b82f6' }}>执行中...</span>;
      case 'completed':
        return <span style={{ color: '#22c55e' }}>成功</span>;
      case 'failed':
        return <span style={{ color: '#ef4444' }}>失败</span>;
    }
  };

  return (
    <div
      style={{
        margin: '8px 0',
        border: '1px solid #334155',
        borderRadius: '6px',
        backgroundColor: '#0f172a',
        fontSize: '13px',
        fontFamily: 'monospace',
        overflow: 'hidden'
      }}
    >
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          backgroundColor: '#1e293b',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>{isExpanded ? '▼' : '▶'}</span>
          <span style={{ fontWeight: 600, color: '#38bdf8' }}>工具调用: {name}</span>
          <span style={{ color: '#64748b', fontSize: '11px' }}>({toolCallId})</span>
        </div>
        <div>{getStatusBadge()}</div>
      </div>

      {isExpanded && (
        <div style={{ padding: '12px', borderTop: '1px solid #334155' }}>
          <div style={{ marginBottom: '8px' }}>
            <div style={{ color: '#94a3b8', fontSize: '11px', marginBottom: '4px' }}>输入参数:</div>
            <pre
              style={{
                margin: 0,
                padding: '8px',
                backgroundColor: '#020617',
                borderRadius: '4px',
                overflowX: 'auto',
                color: '#e2e8f0'
              }}
            >
              {parsedArgs}
            </pre>
          </div>

          {resultText && (
            <div style={{ marginBottom: '8px' }}>
              <div style={{ color: '#94a3b8', fontSize: '11px', marginBottom: '4px' }}>执行结果:</div>
              <pre
                style={{
                  margin: 0,
                  padding: '8px',
                  backgroundColor: '#020617',
                  borderRadius: '4px',
                  overflowX: 'auto',
                  color: '#4ade80'
                }}
              >
                {resultText}
              </pre>
            </div>
          )}

          {errorText && (
            <div>
              <div style={{ color: '#ef4444', fontSize: '11px', marginBottom: '4px' }}>错误信息:</div>
              <pre
                style={{
                  margin: 0,
                  padding: '8px',
                  backgroundColor: '#450a0a',
                  borderRadius: '4px',
                  overflowX: 'auto',
                  color: '#fca5a5'
                }}
              >
                {errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
