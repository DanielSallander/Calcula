//! FILENAME: app/extensions/_template/components/MyPanel.tsx
// PURPOSE: Example task pane component for the template extension.
// USAGE: Register via context.ui.taskPanes.register() in activate().

import React from "react";
import type { TaskPaneViewProps } from "@api/uiTypes";

export function MyPanel({ onClose, data }: TaskPaneViewProps): React.ReactElement {
  return (
    <div style={{ padding: 16 }}>
      <h3>My Extension Panel</h3>
      <p>This is a template task pane. Replace this with your content.</p>
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
      {onClose && (
        <button onClick={onClose} style={{ marginTop: 8 }}>
          Close
        </button>
      )}
    </div>
  );
}
