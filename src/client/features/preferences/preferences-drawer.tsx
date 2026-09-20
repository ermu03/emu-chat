import React from "react";
import { X } from "lucide-react";

export interface PreferencesState {
  theme: "system" | "light" | "dark";
  sidebar_width: number;
  send_shortcut: "enter" | "mod_enter";
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
  onUpdate,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <aside
        className="preferences-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
      >
        <div className="preferences-drawer-header">
          <h2 id="preferences-title">设置</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭设置"
          >
            <X size={17} />
          </button>
        </div>

        <div className="preference-field">
          <label htmlFor="preference-theme">外观</label>
          <select
            id="preference-theme"
            value={preferences.theme}
            onChange={(event) =>
              void onUpdate({
                theme: event.target.value as PreferencesState["theme"],
              })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>

        <div className="preference-field">
          <label htmlFor="preference-shortcut">发送方式</label>
          <select
            id="preference-shortcut"
            value={preferences.send_shortcut}
            onChange={(event) =>
              void onUpdate({
                send_shortcut: event.target
                  .value as PreferencesState["send_shortcut"],
              })
            }
          >
            <option value="enter">Enter 发送</option>
            <option value="mod_enter">Ctrl / Cmd + Enter 发送</option>
          </select>
        </div>

        <div className="preference-field">
          <label htmlFor="preference-sidebar">
            侧栏宽度 · {preferences.sidebar_width}px
          </label>
          <input
            id="preference-sidebar"
            type="range"
            min={240}
            max={420}
            step={10}
            value={preferences.sidebar_width}
            onChange={(event) =>
              void onUpdate({ sidebar_width: Number(event.target.value) })
            }
          />
        </div>

        <div className="preference-note">
          本地偏好版本 {preferences.revision}
        </div>
      </aside>
    </div>
  );
};
