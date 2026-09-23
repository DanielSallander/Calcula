//! FILENAME: app/extensions/Controls/PropertiesPane/ToggleSwitch.tsx
// PURPOSE: On/off switch for boolean properties in the Properties Pane.
// CONTEXT: A thin adapter over the @api/layout Switch (Calcula Clusters), kept
//          under its old name because PropertyRow imports it. The Switch is a
//          real <input type="checkbox" role="switch"> on a token track, so it
//          is keyboard-operable (Space) and announced as a switch — the div it
//          replaced was click-only and invisible to assistive tech, and it
//          hand-built the same track with its own colours.

import React from "react";
import { Switch } from "@api/layout";

// ============================================================================
// Props
// ============================================================================

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

// ============================================================================
// Component
// ============================================================================

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  label,
}) => <Switch checked={checked} onChange={onChange} label={label ?? ""} />;
