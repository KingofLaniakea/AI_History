import React, { useState } from "react";
import { ImportDialog } from "./ImportDialog";

export function SettingsPanel({ folderId }: { folderId: string | null }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="panel settings-panel">
      <div className="settings-header">
        <button
          className={`settings-toggle ${open ? "active" : ""}`}
          onClick={() => setOpen((prev) => !prev)}
        >
          设置
        </button>
        <span className="muted">导入功能已收纳到这里</span>
      </div>

      {open ? (
        <div className="settings-content">
          <ImportDialog folderId={folderId} mode="embedded" />
        </div>
      ) : null}
    </section>
  );
}
