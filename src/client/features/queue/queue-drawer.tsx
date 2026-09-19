import React from 'react';

export interface QueueDrawerItem {
  id: string;
  sequence_number: number;
  content: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
}

interface QueueDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: QueueDrawerItem[];
  onCancelItem: (itemId: string) => Promise<void>;
}

export const QueueDrawer: React.FC<QueueDrawerProps> = ({
  isOpen,
  onClose,
  items,
  onCancelItem,
}) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        backgroundColor: '#1f2430',
        color: '#cbccc6',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px',
          borderBottom: '1px solid #2d3345',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>会话消息队列 ({items.length}/10)</h3>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#cbccc6',
            cursor: 'pointer',
            fontSize: 18,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {items.length === 0 ? (
          <div style={{ color: '#707a8c', textAlign: 'center', marginTop: 40 }}>
            当前没有排队中的消息
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              style={{
                backgroundColor: '#151922',
                borderRadius: 6,
                padding: 12,
                marginBottom: 12,
                border: '1px solid #2d3345',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                  fontSize: 12,
                  color: '#707a8c',
                }}
              >
                <span>#{item.sequence_number}</span>
                <span
                  style={{
                    color:
                      item.status === 'running'
                        ? '#ffb454'
                        : item.status === 'queued'
                        ? '#73d0ff'
                        : '#cbccc6',
                  }}
                >
                  {item.status.toUpperCase()}
                </span>
              </div>
              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.4,
                  maxHeight: 60,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'pre-wrap',
                  marginBottom: 8,
                }}
              >
                {item.content}
              </div>
              {item.status === 'queued' && (
                <div style={{ textAlign: 'right' }}>
                  <button
                    onClick={() => onCancelItem(item.id)}
                    style={{
                      background: '#d95757',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      padding: '4px 8px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    取消排队
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
