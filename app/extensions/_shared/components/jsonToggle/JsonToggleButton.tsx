//! FILENAME: app/extensions/_shared/components/jsonToggle/JsonToggleButton.tsx
// PURPOSE: Small toggle button for switching a config surface between its GUI
//          and its JSON form.
// CONTEXT: Used in the headers of the PivotTable Fields pane and the Slicer
//          Settings dialog. The Chart and Table ribbons no longer use it: their
//          JSON views are task panes toggled from a CommandButton. Built on the
//          @api/layout IconButton so it follows the skin (pressed = on).

import React from "react";
import { IconButton, ICON_SIZE_SM } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";

interface JsonToggleButtonProps {
  isActive: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function JsonToggleButton({
  isActive,
  onClick,
  disabled = false,
  title = "Toggle JSON view",
}: JsonToggleButtonProps): React.ReactElement {
  return (
    <IconButton
      icon={<RibbonIcon.Code size={ICON_SIZE_SM} />}
      label={title}
      title={title}
      tooltip={false}
      size="sm"
      pressed={isActive}
      onClick={onClick}
      disabled={disabled}
    />
  );
}
