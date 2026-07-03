//! FILENAME: app/extensions/ControlsPane/components/CheckboxControl.tsx
// PURPOSE: Boolean checkbox body for a pane control card. Toggling commits
//          the new state immediately (one backend write, one undo entry,
//          one GET.CONTROLVALUE dependent recalc).
// CONTEXT: Rendered inside ControlCard; the config label sits next to the box
//          (it may differ from the control name shown in the card header).

import React, { useState, useCallback, useEffect } from "react";
import { useSurfaceLayout } from "@api/layout";
import type { ControlValue } from "@api/controlValues";
import type { PaneControl } from "../lib/controlsPaneTypes";
import { commitValue } from "../lib/controlsPaneStore";

type CheckboxConfig = Extract<PaneControl["config"], { type: "checkbox" }>;

interface Props {
  control: PaneControl;
}

export function CheckboxControl({ control }: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const label =
    control.config.type === "checkbox"
      ? (control.config as CheckboxConfig).label
      : "";

  const committedChecked =
    control.value?.kind === "boolean" ? control.value.value : false;

  const [checked, setChecked] = useState<boolean>(committedChecked);

  // Sync local state when the value changes externally (undo, script, load).
  useEffect(() => {
    setChecked(committedChecked);
  }, [committedChecked]);

  const handleToggle = useCallback(() => {
    const next = !checked;
    setChecked(next);
    const committed: ControlValue = { kind: "boolean", value: next };
    void commitValue(control.id, committed);
  }, [checked, control.id]);

  return (
    <label
      style={{
        ...styles.row,
        fontSize: band ? "11px" : "12px",
      }}
      title={label || control.name}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={handleToggle}
        style={styles.checkbox}
      />
      {label && <span style={styles.label}>{label}</span>}
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    cursor: "pointer",
    color: "#333",
  },
  checkbox: {
    margin: 0,
    cursor: "pointer",
    flexShrink: 0,
  },
  label: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
