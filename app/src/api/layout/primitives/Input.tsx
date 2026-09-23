//! FILENAME: app/src/api/layout/primitives/Input.tsx
// PURPOSE: Standard text input atom at the shared field height.
// CONTEXT: Companion to Field/FieldGrid so extensions stop hand-rolling input
//          CSS. In the band, inputs default to a compact width unless the
//          author sets one (a full-width input makes no sense inline).
//
//          The chrome is the one text-entry recipe shared with Select and
//          NumberField (`fieldChrome` in ./fields.tsx): FIELD_HEIGHT (28px),
//          the control radius, a 1px LT.controlBorder on LT.inputBg, and on
//          focus the LT.focusRing plus an LT.stateAccent border. The old input
//          drew a 1px outline in --accent-color on a 4px radius, which matched
//          neither the buttons beside it nor the skin's focus colour.
//
//          `className` is cx-merged AFTER the chrome, so a caller's emotion
//          class overrides it regardless of stylesheet insertion order.

import React from "react";
import { css, cx } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { fieldChrome } from "./fields";

/** Band default width when the caller sets none. */
const BAND_INPUT_WIDTH = 64;

const inputPadding = css`
  padding: 0 8px;
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
        className={cx(fieldChrome, inputPadding, className)}
        style={{
          width: width ?? (band ? BAND_INPUT_WIDTH : "100%"),
          ...style,
        }}
        {...rest}
      />
    );
  },
);
