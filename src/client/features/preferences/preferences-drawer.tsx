import React from 'react';

export interface PreferencesState {
  theme: 'system' | 'light' | 'dark';
  sidebar_width: number;
  send_shortcut: 'enter' | 'mod_enter';
  revision: number;
}

export interface PreferencesDrawerProps {
  isOpen: boolean;
  preferences: PreferencesState;
  onClose: () => void;
  onUpdate: (patch: Partial<PreferencesState>) => Promise<void>;
}

export const PreferencesDrawer: React.FC<PreferencesDrawerProps> = ({
  isOpen,
  preferences,
  onClose,
  onUpdate
}) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 50
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '360px',
          height: '100%',
          backgroundColor: '#ffffff',
          padding: '24px',
          boxShadow: '-4px 0 12px rgba(0, 0, 0, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>偏好设置</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '18px',
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '14px', marginBottom: '8px', fontWeight: 500 }}>
            外观主题
          </label>
          <select
            value={preferences.theme}
            onChange={(e) =>
              onUpdate({ theme: e.target.value as 'system' | 'light' | 'dark' })
            }
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #d1d5db'
            }}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色模式</option>
            <option value="dark">深色模式</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '14px', marginBottom: '8px', fontWeight: 500 }}>
            发送快捷键
          </label>
          <select
            value={preferences.send_shortcut}
            onChange={(e) =>
              onUpdate({ send_shortcut: e.target.value as 'enter' | 'mod_enter' })
            }
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #d1d5db'
            }}
          >
            <option value="enter">Enter 发送 (Shift+Enter 换行)</option>
            <option value="mod_enter">Ctrl+Enter / Cmd+Enter 发送</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '14px', marginBottom: '8px', fontWeight: 500 }}>
            侧边栏宽度 ({preferences.sidebar_width}px)
          </label>
          <input
            type="range"
            min={240}
            max={480}
            step={10}
            value={preferences.sidebar_width}
            onChange={(e) => onUpdate({ sidebar_width: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginTop: 'auto', fontSize: '12px', color: '#9ca3af' }}>
          偏好设置 revision: {preferences.revision}
        </div>
      </div>
    </div>
  );
};
