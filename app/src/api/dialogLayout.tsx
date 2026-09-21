//! FILENAME: app/src/api/dialogLayout.tsx
// PURPOSE: Shared layout primitives for dialog bodies — the horizontal
//          counterpart to @api/dialogWindow's drag/resize behavior.
// CONTEXT: Dialogs render their own chrome (there is no shell-owned frame), so
//   every one of them hand-rolls its body layout too. The failure mode that
//   produced this module: a dialog declares a narrow fixed width, stacks every
//   field group vertically, and the user gets a tall scrolling straw instead of
//   a form. Insert Chart was 620px wide with a 220px live preview parked BELOW
//   the settings, so the preview — the whole point of the dialog — was off
//   screen while you configured the chart.
//
//   The cure is horizontal space, and it is the same cure every time:
//
//     <DialogBody>                       // row: settings | side pane
//       <DialogPane scroll>              // the settings, scrolls on its own
//         <DialogFieldGrid>…</DialogFieldGrid>   // fields flow into columns
//       </DialogPane>
//       <DialogSidePane width={380}>…</DialogSidePane>   // preview, pinned
//     </DialogBody>
//
//   Nothing here owns chrome, theming or window behavior: these are layout
//   containers that read the same CSS custom properties the dialogs already
//   use, so they drop into a styled-components dialog, an emotion one, or an
//   inline-styled one without a rewrite.
//
//   Deliberately plain inline styles, matching @api/layout's primitives — @api
//   has no styled-components dependency and must not grow one.

import React, { useCallback, useMemo, useRef, useState } from "react";

// ============================================================================
// Tokens
// ============================================================================

/** Gutter between dialog panes. */
export const DIALOG_PANE_GAP = 16;
/** Padding inside a dialog pane. */
export const DIALOG_PANE_PADDING = 16;
/** Narrowest a field column may become before the grid drops to one column. */
export const DIALOG_FIELD_MIN_WIDTH = 210;
/** Default width of a pinned side pane (preview/summary). */
export const DIALOG_SIDE_PANE_WIDTH = 360;

const BORDER = "var(--border-default)";

// ============================================================================
// DialogBody — the horizontal split
// ============================================================================

export interface DialogBodyProps {
  children: React.ReactNode;
  /** Stack panes vertically instead (narrow dialogs, or a caller-driven mode). */
  stacked?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * The region between a dialog's tab bar/header and its footer. Lays its panes
 * out in a row and owns the flex bookkeeping that makes inner scrolling work
 * (`minHeight: 0` is the reason a child's `overflow-y: auto` scrolls instead of
 * the whole dialog growing).
 */
export const DialogBody = React.forwardRef<HTMLDivElement, DialogBodyProps>(
  function DialogBody({ children, stacked = false, style, className }, ref) {
    return (
      <div
        ref={ref}
        className={className}
        style={{
          display: "flex",
          flexDirection: stacked ? "column" : "row",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);

// ============================================================================
// DialogPane — a scrolling column of settings
// ============================================================================

export interface DialogPaneProps {
  children: React.ReactNode;
  /** Scroll this pane's own overflow rather than the dialog's. Default true. */
  scroll?: boolean;
  /** Flex grow factor. Default 1. */
  grow?: number;
  /** Fixed basis in px — use for a pane that must not shrink below a width. */
  width?: number;
  /** Smallest width the pane may flex to. Default 0. */
  minWidth?: number;
  /** Inner padding. Default DIALOG_PANE_PADDING. */
  padding?: number | string;
  style?: React.CSSProperties;
  className?: string;
  "data-testid"?: string;
}

/**
 * A content column inside a DialogBody. The settings side of a two-pane dialog
 * is a `<DialogPane scroll>`; it is the ONLY thing that scrolls, so the header,
 * the tab bar, the footer and any pinned side pane stay put.
 */
export function DialogPane({
  children,
  scroll = true,
  grow = 1,
  width,
  minWidth = 0,
  padding = DIALOG_PANE_PADDING,
  style,
  className,
  "data-testid": testId,
}: DialogPaneProps): React.ReactElement {
  return (
    <div
      className={className}
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: width != null ? `0 0 ${width}px` : `${grow} 1 0%`,
        minWidth,
        minHeight: 0,
        overflowY: scroll ? "auto" : "visible",
        overflowX: scroll ? "hidden" : "visible",
        padding,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// DialogSidePane — the pinned companion (preview, summary, result)
// ============================================================================

export interface DialogSidePaneProps {
  children: React.ReactNode;
  /** Optional caption above the pane's content. */
  title?: string;
  /** Pane width in px. Default DIALOG_SIDE_PANE_WIDTH. */
  width?: number;
  /** Let the pane flex instead of holding a fixed width. */
  flexible?: boolean;
  /** Which edge carries the divider rule. Default "left". */
  border?: "left" | "right" | "none";
  style?: React.CSSProperties;
  className?: string;
  "data-testid"?: string;
}

/**
 * A pane that stays visible while the settings pane scrolls. This is what makes
 * a live preview worth having: it is in view the entire time you are changing
 * the thing it previews.
 */
export function DialogSidePane({
  children,
  title,
  width = DIALOG_SIDE_PANE_WIDTH,
  flexible = false,
  border = "left",
  style,
  className,
  "data-testid": testId,
}: DialogSidePaneProps): React.ReactElement {
  return (
    <div
      className={className}
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: flexible ? "1 1 0%" : `0 0 ${width}px`,
        minWidth: 0,
        minHeight: 0,
        padding: DIALOG_PANE_PADDING,
        boxSizing: "border-box",
        borderLeft: border === "left" ? `1px solid ${BORDER}` : undefined,
        borderRight: border === "right" ? `1px solid ${BORDER}` : undefined,
        gap: 8,
        ...style,
      }}
    >
      {title && <DialogPaneTitle>{title}</DialogPaneTitle>}
      {children}
    </div>
  );
}

// ============================================================================
// DialogPaneTitle — the small uppercase caption used across dialogs
// ============================================================================

export function DialogPaneTitle({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.4px",
        color: "var(--text-secondary)",
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// DialogFieldGrid — fields flow into as many columns as the width allows
// ============================================================================

export interface DialogFieldGridProps {
  children: React.ReactNode;
  /**
   * Narrowest a column may be before the grid drops one. Raise it for fields
   * whose controls need room (a range picker, a formula box); lower it for
   * checkboxes. Default DIALOG_FIELD_MIN_WIDTH.
   */
  minColumnWidth?: number;
  /** Hard ceiling on columns, e.g. 2 when three would read as noise. */
  maxColumns?: number;
  columnGap?: number;
  rowGap?: number;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * `auto-fit` + `minmax` — the grid grows a column whenever the dialog is wide
 * enough for one and collapses back when the user drags it narrow, with no
 * media query and no measurement. A field group that must not be split across
 * columns wraps itself in <DialogFieldSpan>.
 */
export function DialogFieldGrid({
  children,
  minColumnWidth = DIALOG_FIELD_MIN_WIDTH,
  maxColumns,
  columnGap = 24,
  rowGap = 2,
  style,
  className,
}: DialogFieldGridProps): React.ReactElement {
  // `auto-fit` fits as many tracks as the MINIMUM allows, so a ceiling on the
  // column count is a floor on the track width: raise each track's minimum to
  // the width N columns would take, and only N can ever fit. Writing the cap as
  // a track MAXIMUM (`minmax(210px, 50%)`) does not cap anything — the minimum
  // still governs, and a 900px pane lays out FOUR columns.
  const template =
    maxColumns != null
      ? `repeat(auto-fit, minmax(max(${minColumnWidth}px, calc((100% - ${
          columnGap * (maxColumns - 1)
        }px) / ${maxColumns})), 1fr))`
      : `repeat(auto-fit, minmax(${minColumnWidth}px, 1fr))`;

  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: template,
        columnGap,
        rowGap,
        alignItems: "start",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A child of DialogFieldGrid that spans every column (a wide list, an editor). */
export function DialogFieldSpan({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return <div style={{ gridColumn: "1 / -1", minWidth: 0, ...style }}>{children}</div>;
}

// ============================================================================
// DialogSection — a titled block inside a pane
// ============================================================================

export function DialogSection({
  title,
  children,
  style,
}: {
  title?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, ...style }}>
      {title && (
        <DialogPaneTitle
          style={{
            marginBottom: 6,
            paddingBottom: 3,
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          {title}
        </DialogPaneTitle>
      )}
      {children}
    </div>
  );
}

// ============================================================================
// useDialogSplit — a draggable divider between two panes
// ============================================================================

export interface DialogSplitOptions {
  /** Starting share of the width taken by the primary pane (0..1). Default 0.62. */
  initial?: number;
  /** Smallest share the primary pane may shrink to. Default 0.3. */
  min?: number;
  /** Largest share the primary pane may grow to. Default 0.8. */
  max?: number;
}

export interface DialogSplitApi {
  /** Attach to the DialogBody that hosts the two panes. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Spread onto the FIRST pane — pins it to the current share. */
  primaryStyle: React.CSSProperties;
  /** Spread onto the SECOND pane — it takes whatever is left. */
  secondaryStyle: React.CSSProperties;
  /** Render between the two panes. */
  splitter: React.ReactNode;
  /** Back to the initial share (call when the dialog reopens). */
  reset: () => void;
}

const SPLITTER_WIDTH = 7;

/**
 * Lets the user decide how much room the settings get versus the preview.
 * A fixed split is a guess about which half the user cares about; this makes it
 * their call, and costs one drag handle.
 */
export function useDialogSplit(options: DialogSplitOptions = {}): DialogSplitApi {
  const { initial = 0.62, min = 0.3, max = 0.8 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initial);
  const baseRatio = useRef(initial);
  const [dragging, setDragging] = useState(false);

  const reset = useCallback(() => setRatio(initial), [initial]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      baseRatio.current = ratio;
      const startX = e.clientX;
      setDragging(true);

      const onMove = (moveEvent: MouseEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const total = container.clientWidth;
        if (total === 0) return;
        const next = baseRatio.current + (moveEvent.clientX - startX) / total;
        setRatio(Math.max(min, Math.min(max, next)));
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setDragging(false);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [ratio, min, max],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setRatio((r) => Math.max(min, r - step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setRatio((r) => Math.min(max, r + step));
      } else if (e.key === "Home") {
        e.preventDefault();
        setRatio(initial);
      }
    },
    [min, max, initial],
  );

  const splitter = useMemo(
    () => (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        tabIndex={0}
        data-testid="dialog-splitter"
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        style={{
          flex: `0 0 ${SPLITTER_WIDTH}px`,
          cursor: "col-resize",
          position: "relative",
          alignSelf: "stretch",
          outline: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "50%",
            width: 1,
            transform: "translateX(-50%)",
            background: dragging ? "var(--accent-primary)" : BORDER,
            transition: "background 0.1s",
          }}
        />
      </div>
    ),
    [onMouseDown, onKeyDown, dragging],
  );

  return {
    containerRef,
    primaryStyle: { flex: `0 0 calc(${(ratio * 100).toFixed(3)}% - ${SPLITTER_WIDTH / 2}px)` },
    secondaryStyle: { flex: "1 1 0%" },
    splitter,
    reset,
  };
}

// ============================================================================
// Width helpers
// ============================================================================

/**
 * A dialog width that prefers `preferred` but never overflows a small screen.
 * Returned as a CSS value so it lives in the stylesheet, where the user's own
 * resize (useDialogWindow) can still override it wholesale.
 */
export function dialogWidth(preferred: number, viewportFraction = 0.94): string {
  return `min(${preferred}px, ${Math.round(viewportFraction * 100)}vw)`;
}

/** Same, for height. */
export function dialogHeight(preferred: number, viewportFraction = 0.88): string {
  return `min(${preferred}px, ${Math.round(viewportFraction * 100)}vh)`;
}
