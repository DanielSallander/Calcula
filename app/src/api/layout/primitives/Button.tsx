//! FILENAME: app/src/api/layout/primitives/Button.tsx
// PURPOSE: Standard control atoms (Button, ToggleButton) with the shell's
//          native panel/ribbon visuals.
// CONTEXT: Gives extensions the standard control look without hand-rolled CSS
//          (and without importing shell internals). Density follows the
//          SurfaceLayoutContext: compact in the band, comfortable elsewhere.

import React from "react";
import { css, cx } from "@emotion/css";
import { CONTROL_HEIGHT_MD, CONTROL_HEIGHT_SM, FONT_FAMILY } from "../tokens";

const base = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--button-bg, transparent);
  color: var(--text-primary, #333);
  cursor: pointer;
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  box-sizing: border-box;
  white-space: nowrap;
  transition: background-color 80ms ease-out, border-color 80ms ease-out;

  &:hover:not(:disabled) {
    background: var(--button-hover-bg, rgba(0, 0, 0, 0.06));
  }

  &:active:not(:disabled) {
    background: var(--button-active-bg, rgba(0, 0, 0, 0.1));
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const pressed = css`
  background: var(--button-pressed-bg, rgba(16, 185, 129, 0.14));
  border-color: var(--button-pressed-border, rgba(16, 185, 129, 0.45));

  &:hover:not(:disabled) {
    background: var(--button-pressed-bg, rgba(16, 185, 129, 0.14));
  }
`;

/** Visible boundary at rest — for buttons that stand alone on a surface
 *  (pane control cards, dialogs) rather than in ribbon/toolbar rows, where
 *  the flat look would read as plain text. */
const outlined = css`
  border-color: var(--border-default, #d0d0d0);
  background: var(--bg-surface, #fff);

  &:hover:not(:disabled) {
    background: var(--bg-surface-disabled, #f5f5f5);
  }
`;

export interface LayoutButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** "sm" = compact 22px list-row button; "md" = standard 26px control. */
  size?: "sm" | "md";
  /** Stretch to fill the row. */
  grow?: boolean;
  /** "flat" (default) = transparent at rest, ribbon/toolbar idiom;
   *  "outlined" = visible border + surface background at rest. */
  variant?: "flat" | "outlined";
}

/** A standard button at the shared control height for the current density. */
export function Button({
  size = "md",
  grow,
  variant = "flat",
  style,
  className,
  children,
  ...rest
}: LayoutButtonProps): React.ReactElement {
  const compact = size === "sm";
  const height = compact ? CONTROL_HEIGHT_SM : CONTROL_HEIGHT_MD;

  return (
    <button
      className={cx(base, variant === "outlined" && outlined, className)}
      style={{
        height,
        minWidth: compact ? 0 : 28,
        padding: "0 6px",
        ...(grow ? { flex: 1 } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface ToggleButtonProps extends LayoutButtonProps {
  /** Whether the toggle is currently on (bold/italic/loop-style state). */
  active: boolean;
}

/** A Button with a pressed state for on/off controls. */
export function ToggleButton({
  active,
  className,
  ...rest
}: ToggleButtonProps): React.ReactElement {
  return (
    <Button
      className={cx(className, active ? pressed : undefined)}
      aria-pressed={active}
      {...rest}
    />
  );
}
