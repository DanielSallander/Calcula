//! FILENAME: app/extensions/ControlsPane/components/CheckboxControl.tsx
// PURPOSE: Boolean checkbox body for a pane control card. Toggling commits
//          the new state immediately (one backend write, one undo entry,
//          one GET.CONTROLVALUE dependent recalc).
// CONTEXT: Rendered inside ControlCard; the config label sits next to the box
//          (it may differ from the control name shown in the card header).
//          Drawn by the @api Checkbox — a real <input type="checkbox"> on
//          token chrome (11px text and one 28px row in the band, 12px in the
//          sidebar) — instead of an OS box that stayed white in Dark.

import React, { useState, useCallback, useEffect } from "react";
import { Checkbox } from "@api/layout";
import type { ControlValue } from "@api/controlValues";
import type { PaneControl } from "../lib/controlsPaneTypes";
import { commitValue } from "../lib/controlsPaneStore";

type CheckboxConfig = Extract<PaneControl["config"], { type: "checkbox" }>;

interface Props {
  control: PaneControl;
}

export function CheckboxControl({ control }: Props): React.ReactElement {
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

  const handleToggle = useCallback(
    (next: boolean) => {
      setChecked(next);
      const committed: ControlValue = { kind: "boolean", value: next };
      void commitValue(control.id, committed);
    },
    [control.id],
  );

  return (
    <Checkbox
      checked={checked}
      onChange={handleToggle}
      label={label}
      // With no visible label the box still needs a name.
      aria-label={label ? undefined : control.name}
      title={label || control.name}
      style={styles.row}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    minWidth: 0,
  },
};
