//! FILENAME: app/src/api/layout/primitives/Input.tsx
// PURPOSE: Standard text/number input atom at the shared field height.
// CONTEXT: Companion to Field/FieldGrid so extensions stop hand-rolling input
//          CSS. In the band, inputs default to a compact width unless the
//          author sets one (a full-width input makes no sense inline).

import React from "react";
import { css, cx } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { FIELD_HEIGHT, FONT_FAMILY } from "../tokens";

const base = css`
  height: ${FIELD_HEIGHT}px;
  box-sizing: border-box;
  padding: 0 6px;
  border: 1px solid var(--border-default, #d0d0d0);
  border-radius: 4px;
  background: var(--input-bg, #fff);
  color: var(--text-primary, #333);
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  min-width: 0;

  &:focus {
    outline: 1px solid var(--accent-color, #0078d4);
    outline-offset: -1px;
  }
`;

export interface LayoutInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Fixed width in px; band default is 64, panel default is 100%. */
  width?: number;
}

/** A standard input at the shared field height for the current surface. */
export const Input = React.forwardRef<HTMLInputElement, LayoutInputProps>(
  function Input({ width, style, className, ...rest }, ref): React.ReactElement {
    const layout = useSurfaceLayout();
    const band = layout.container === "band";

    return (
      <input
        ref={ref}
        className={cx(base, className)}
        style={{
          width: width ?? (band ? 64 : "100%"),
          ...style,
        }}
        {...rest}
      />
    );
  },
);
