//! FILENAME: app/src/shell/DialogContainer.tsx
// PURPOSE: Renders all active dialogs registered via DialogExtensions.
// CONTEXT: This component subscribes to the dialog registry and renders
// dialog components dynamically, removing the need for hardcoded dialog imports.

import React, { useState, useEffect, useCallback } from "react";
import { DialogExtensions } from "../api/ui";
import type { DialogDefinition } from "../api/uiTypes";

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

  const activeDialogs = DialogExtensions.getVisibleDialogs();

  // Close the topmost Escape-dismissible dialog on Escape (capture phase so
  // Monaco can't swallow it). Dialogs with dismissOnEscape === false are
  // non-modal floating windows: Escape passes through to the grid untouched.
  //
  // EXCEPT when the key comes from inside a popover the dialog opened (a colour
  // palette, a Dropdown list, a Menu — every @api/layout overlay is portalled
  // into a `[data-section-flyout]`). That Escape belongs to the popover, which
  // closes itself and hands focus back to its trigger. Taking it here closed
  // the whole Format Cells dialog — without its reset() — when the user only
  // meant to dismiss the colour palette, because this capture listener runs
  // before anything the popover or the dialog can do.
  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("[data-section-flyout]")) return;
    const dismissible = activeDialogs.filter(
      (d) => d.definition.dismissOnEscape !== false
    );
    if (dismissible.length > 0) {
      const top = dismissible[dismissible.length - 1];
      DialogExtensions.closeDialog(top.definition.id);
      e.stopPropagation();
    }
  }, [activeDialogs]);

  useEffect(() => {
    if (activeDialogs.length === 0) return;
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [activeDialogs.length, handleEscape]);

  return (
    <>
      {activeDialogs.map(({ definition, data }: { definition: DialogDefinition; data?: Record<string, unknown> }) => {
        const DialogComponent = definition.component;
        return (
          <DialogComponent
            key={definition.id}
            isOpen={true}
            onClose={() => DialogExtensions.closeDialog(definition.id)}
            data={data}
          />
        );
      })}
    </>
  );
}