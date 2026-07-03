//! FILENAME: app/extensions/ControlsPane/components/ButtonControl.tsx
// PURPOSE: Clickable button body for a pane control card. Value-less — a
//          click emits the SAME "button:clicked" app event the on-grid
//          Controls extension emits in run mode, with instanceId
//          "pane-" + control id, so an objectType "button" object script's
//          button.onClick hook fires (consent-gated path, never inline code).
// CONTEXT: The scriptHost forwarder (api/scriptHost/host.ts, button.onClick)
//          filters on instanceId and expects detail { instanceId, x, y };
//          the on-grid emitter uses x: 0, y: 0 — mirrored here exactly.

import React, { useCallback } from "react";
import { emitAppEvent } from "@api";
import { Button, useSurfaceLayout } from "@api/layout";
import type { PaneControl } from "../lib/controlsPaneTypes";

type ButtonConfig = Extract<PaneControl["config"], { type: "button" }>;

interface Props {
  control: PaneControl;
}

export function ButtonControl({ control }: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const label =
    control.config.type === "button"
      ? (control.config as ButtonConfig).label || control.name
      : control.name;

  const handleClick = useCallback(() => {
    // Same event + payload shape as the on-grid Controls extension
    // (extensions/Controls/index.ts run-mode click) so button object
    // scripts hook pane buttons with zero new script surface.
    emitAppEvent("button:clicked", {
      instanceId: `pane-${control.id}`,
      x: 0,
      y: 0,
    });
  }, [control.id]);

  return (
    <Button
      size={band ? "sm" : "md"}
      grow
      onClick={handleClick}
      title={`${control.name} (button)`}
      style={styles.button}
    >
      <span style={styles.label}>{label}</span>
    </Button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    minWidth: 0,
    maxWidth: "100%",
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};
