//! FILENAME: app/src/api/layout/primitives/Select.tsx
// PURPOSE: Standard dropdown-select atom at the shared field height.
// CONTEXT: Companion to Input — the ribbon's font-name/size and number-format
//          pickers, and any panel select, share one themed control instead of
//          per-extension hand-rolled <select> CSS. Band default width is
//          compact; panel stretches like Input.
//
//          It stays a NATIVE <select>: the OS list is keyboard-complete,
//          type-ahead works, and every existing caller (and E2E journey)
//          drives it with `select.value` + a change event. What changes is the
//          closed box. `appearance: none` removes the OS-drawn trigger, which
//          ignored the skin, and the control grammar's 9px DropdownChevron is
//          drawn instead, absolutely positioned 9px from the right edge over
//          26px of right padding reserved for it. A <select> cannot hold a
//          child element, so the chevron needs a wrapper:
//
//            <span wrapper: position relative, inline-flex, THE WIDTH>
//              <select: fills the wrapper, gets className/style/ref/...rest/>
//              <span chevron, pointer-events none/>
//            </span>
//
//          Width belongs to the wrapper (so the chevron sits at the box's real
//          right edge); `className` and `style` stay on the <select>, because
//          that is what every existing caller meant them for (a font preview
//          in `style.fontFamily`, a testid, a title). A caller that sized the
//          select through `style.width` instead of `width` keeps that size:
//          the wrapper then shrinks to the select rather than imposing the
//          surface default on it.
//
//          Disabled dims the WRAPPER, not the select: dimming the select would
//          leave the chevron at full strength beside a faded box, and dimming
//          both would compound to .25. A multi-row list (`multiple`, or
//          `size` > 1) has no trigger to decorate, so it gets no chevron and
//          sizes to its rows.

import React from "react";
import { css, cx } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { DropdownChevron } from "./Button";
import { fieldChrome } from "./fields";

/** Band default width when the caller sets none. */
const BAND_SELECT_WIDTH = 96;
/** Chevron glyph size in a 28px control (the grammar's rule: 9 in 28). */
const CHEVRON_SIZE = 9;
/** Chevron distance from the right edge. */
const CHEVRON_RIGHT = 9;

const wrapper = css`
  position: relative;
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;

  &[data-disabled="true"] {
    opacity: 0.5;
  }
`;

const selectBox = css`
  appearance: none;
  width: 100%;
  padding: 0 26px 0 10px;
  line-height: normal;
  cursor: pointer;
  text-overflow: ellipsis;

  /* The wrapper carries the disabled opacity; see the header. */
  &:disabled {
    opacity: 1;
  }
`;

/** A multi-row list: no trigger, no chevron room, height from its rows. */
const listBox = css`
  width: 100%;
  height: auto;
  padding: 4px;

  &:disabled {
    opacity: 1;
  }
`;

const chevron = css`
  position: absolute;
  top: 50%;
  right: ${CHEVRON_RIGHT}px;
  display: flex;
  transform: translateY(-50%);
  color: ${LT.textSecondary};
  pointer-events: none;
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
    const multiRow = Boolean(rest.multiple) || (typeof rest.size === "number" && rest.size > 1);

    // The caller's explicit `width` wins; a `style.width` on the select means
    // "size me yourself" (wrapper shrinks to fit); otherwise the surface
    // default applies.
    const wrapperWidth =
      width ?? (style?.width !== undefined ? undefined : band ? BAND_SELECT_WIDTH : "100%");

    return (
      <span
        className={wrapper}
        style={{ width: wrapperWidth }}
        data-disabled={rest.disabled ? "true" : undefined}
      >
        <select
          ref={ref}
          className={cx(fieldChrome, multiRow ? listBox : selectBox, className)}
          style={style}
          {...rest}
        >
          {children}
        </select>
        {!multiRow && (
          <span className={chevron} aria-hidden>
            <DropdownChevron size={CHEVRON_SIZE} />
          </span>
        )}
      </span>
    );
  },
);
