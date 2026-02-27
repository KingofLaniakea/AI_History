import React, { useState } from "react";
import { ImportDialog } from "./ImportDialog";
import { useExportBackup } from "../hooks/useData";

export function SettingsPanel({ folderId }: { folderId: string | null }) {
  const [open, setOpen] = useState(false);
  const exportMutation = useExportBackup();

  return (
    <section className="panel settings-panel">
      <div className="settings-header">
        <button
          className={`settings-toggle ${open ? "active" : ""}`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          设置
        </button>
        <span className="muted">导入功能已收纳到这里</span>
      </div>

      {open ? (
        <div className="settings-content">
          <ImportDialog folderId={folderId} mode="embedded" />
          <div style={{ padding: "12px", borderTop: "1px solid var(--border-light)" }}>
            <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>数据备份</p>
            <button
              style={{ width: "100%", display: "flex", justifyContent: "center", gap: 6 }}
              onClick={() => {
                exportMutation.mutate(undefined, {
                  onSuccess: (name) => {
                    window.alert(`备份已导出: ${name}`);
                  }
                });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              导出全量数据
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
