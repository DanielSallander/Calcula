//! FILENAME: app/src/shell/DialogContainer.tsx
// PURPOSE: Renders all active dialogs registered via DialogExtensions.
// CONTEXT: This component subscribes to the dialog registry and renders
// dialog components dynamically, removing the need for hardcoded dialog imports.

import React, { useState, useEffect } from "react";
import { DialogExtensions } from "../api/ui";
import type { DialogDefinition } from "../api/uiTypes";

interface DialogState {
  isOpen: boolean;
  data?: Record<string, unknown>;
}

/**
 * Container that renders all active dialogs from the DialogExtensions registry.
 * Place this component at the root of your layout to enable dynamic dialog rendering.
 */
export function DialogContainer(): React.ReactElement {
  const [, forceUpdate] = useState({});

  // Subscribe to dialog registry changes
  useEffect(() => {
    return DialogExtensions.onChange(() => {
      forceUpdate({});
    });
  }, []);

  const activeDialogs = DialogExtensions.getOpenDialogs();

  return (
    <>
      {activeDialogs.map(({ definition, state }: { definition: DialogDefinition; state: DialogState }) => {
        const DialogComponent = definition.component;
        return (
          <DialogComponent
            key={definition.id}
            isOpen={state.isOpen}
            onClose={() => DialogExtensions.closeDialog(definition.id)}
            data={state.data}
          />
        );
      })}
    </>
  );
}