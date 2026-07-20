//! FILENAME: app/src/api/layout/primitives/Select.tsx
// PURPOSE: Standard dropdown-select atom at the shared field height.
// CONTEXT: Companion to Input — the ribbon's font-name/size and number-format
//          pickers, and any panel select, share one themed control instead of
//          per-extension hand-rolled <select> CSS. Band default width is
//          compact; panel stretches like Input.

import React from "react";
import { css, cx } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { FIELD_HEIGHT, FONT_FAMILY } from "../tokens";

const base = css`
  height: ${FIELD_HEIGHT}px;
  box-sizing: border-box;
  padding: 0 4px;
  border: 1px solid var(--border-default, #d0d0d0);
  border-radius: 4px;
  background: var(--bg-surface, #fff);
  color: var(--text-primary, #333);
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  min-width: 0;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--text-tertiary, #999);
  }

  &:focus {
    outline: 1px solid var(--accent-primary, #10b981);
    outline-offset: -1px;
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

export interface LayoutSelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Fixed width in px; band default is 96, panel default is 100%. */
  width?: number;
}

/** A standard select at the shared field height for the current surface. */
export const Select = React.forwardRef<HTMLSelectElement, LayoutSelectProps>(
  function Select({ width, style, className, children, ...rest }, ref): React.ReactElement {
    const layout = useSurfaceLayout();
    const band = layout.container === "band";

    return (
      <select
        ref={ref}
        className={cx(base, className)}
        style={{
          width: width ?? (band ? 96 : "100%"),
          ...style,
        }}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
