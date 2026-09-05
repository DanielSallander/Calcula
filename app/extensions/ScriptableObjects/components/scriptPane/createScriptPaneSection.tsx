//! FILENAME: app/extensions/ScriptableObjects/components/scriptPane/createScriptPaneSection.tsx
// PURPOSE: The `PanelSection.component` factory for ONE script task pane.
//          `PanelSectionProps` carries no identity of its own (the placement,
//          and the host's onClose in the sidebar), so the component is closed
//          over its store — one definition per pane, minted by the wiring
//          (lib/scriptPaneHost.ts) from the host-supplied pane id. Kept apart
//          from ScriptPaneSection.tsx so that file exports components only.

import React from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import type { ScriptPaneStore } from "../../lib/scriptPaneStore";
import { ScriptPaneView } from "./ScriptPaneSection";

export function createScriptPaneSection(store: ScriptPaneStore): React.ComponentType<PanelSectionProps> {
  function ScriptPaneSection({ onClose }: PanelSectionProps): React.ReactElement {
    return <ScriptPaneView store={store} onHostClose={onClose} />;
  }
  ScriptPaneSection.displayName = `ScriptPaneSection(${store.paneId})`;
  return ScriptPaneSection;
}
