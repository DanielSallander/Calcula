//! FILENAME: app/src/api/dialogWindow.tsx
// PURPOSE: Shared drag-to-move + drag-to-resize behavior for dialog windows.
// CONTEXT: Dialogs render their own chrome (there is no shell-owned frame), so
//   this hook retrofits any dialog with window behavior in a few lines:
//
//     const win = useDialogWindow({ minWidth: 480, minHeight: 320 });
//     <Container ref={win.ref} style={{ ...myPositionStyle, ...win.style }}>
//       <Header onMouseDown={win.onHeaderMouseDown}>…</Header>
//       …content…
//       {win.resizeHandles}
//     </Container>
//
//   The container must be `position: fixed` (all dialogs are). Until the user
//   drags or resizes, `win.style` is empty, so the dialog's own centering
//   (e.g. left:50% + translate(-50%,-50%)) applies untouched. On first
//   interaction the current on-screen rect is materialized into concrete
//   left/top/width/height, the transform is neutralized, and the user is in
//   control from then on.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface DialogWindowOptions {
  /** Smallest width the user can resize to (px). Default 320. */
  minWidth?: number;
  /** Smallest height the user can resize to (px). Default 200. */
  minHeight?: number;
  /** Set false for a fixed-size (still movable) dialog. Default true. */
  resizable?: boolean;
}

export interface DialogWindowApi {
  /** Attach to the dialog box element. */
  ref: React.RefObject<HTMLDivElement>;
  /** Position/size overrides — spread AFTER the dialog's own style props. */
  style: React.CSSProperties;
  /** Attach to the title-bar element to drag-move the dialog. */
  onHeaderMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  /** Render inside the dialog box (typically as the last child). */
  resizeHandles: React.ReactNode;
  /** Forget user position/size — back to the dialog's own CSS placement.
   *  Call when (re)opening so a dialog opens centered at its natural size. */
  reset: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The 8 resize zones: [name, dx, dy, cursor]. dx/dy: which edge moves. */
const HANDLES: Array<[string, -1 | 0 | 1, -1 | 0 | 1, string]> = [
  ["n", 0, -1, "ns-resize"],
  ["s", 0, 1, "ns-resize"],
  ["e", 1, 0, "ew-resize"],
  ["w", -1, 0, "ew-resize"],
  ["ne", 1, -1, "nesw-resize"],
  ["sw", -1, 1, "nesw-resize"],
  ["nw", -1, -1, "nwse-resize"],
  ["se", 1, 1, "nwse-resize"],
];

const EDGE = 6; // hit thickness of edge handles (px)
const CORNER = 12; // hit size of corner handles (px)

function handleStyle(name: string, cursor: string): React.CSSProperties {
  const s: React.CSSProperties = { position: "absolute", cursor, zIndex: 10 };
  switch (name) {
    case "n":
      Object.assign(s, { top: -3, left: CORNER, right: CORNER, height: EDGE });
      break;
    case "s":
      Object.assign(s, { bottom: -3, left: CORNER, right: CORNER, height: EDGE });
      break;
    case "e":
      Object.assign(s, { right: -3, top: CORNER, bottom: CORNER, width: EDGE });
      break;
    case "w":
      Object.assign(s, { left: -3, top: CORNER, bottom: CORNER, width: EDGE });
      break;
    case "ne":
      Object.assign(s, { top: -3, right: -3, width: CORNER, height: CORNER });
      break;
    case "nw":
      Object.assign(s, { top: -3, left: -3, width: CORNER, height: CORNER });
      break;
    case "se":
      Object.assign(s, { bottom: -3, right: -3, width: CORNER, height: CORNER });
      break;
    case "sw":
      Object.assign(s, { bottom: -3, left: -3, width: CORNER, height: CORNER });
      break;
  }
  return s;
}

/**
 * Drag + resize state machine for a fixed-position dialog box.
 * See the file header for the wiring recipe.
 */
export function useDialogWindow(options: DialogWindowOptions = {}): DialogWindowApi {
  const { minWidth = 320, minHeight = 200, resizable = true } = options;

  const ref = useRef<HTMLDivElement>(null);
  // null until the user first drags/resizes — the dialog's own CSS positions it.
  const [rect, setRect] = useState<Rect | null>(null);
  const reset = useCallback(() => setRect(null), []);

  // Live drag state (refs — no re-render per mousemove; setRect drives paint).
  const dragState = useRef<{
    mode: "move" | "resize";
    dx: -1 | 0 | 1;
    dy: -1 | 0 | 1;
    startMouseX: number;
    startMouseY: number;
    startRect: Rect;
  } | null>(null);

  /** Current on-screen rect: the materialized state, else the live DOM rect. */
  const currentRect = useCallback((): Rect | null => {
    if (rect) return rect;
    const el = ref.current;
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, [rect]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragState.current;
      if (!st) return;
      e.preventDefault();
      const dxPx = e.clientX - st.startMouseX;
      const dyPx = e.clientY - st.startMouseY;

      if (st.mode === "move") {
        setRect({
          ...st.startRect,
          x: Math.min(
            Math.max(st.startRect.x + dxPx, 8 - st.startRect.width),
            window.innerWidth - 40,
          ),
          y: Math.min(Math.max(st.startRect.y + dyPx, 0), window.innerHeight - 40),
        });
        return;
      }

      // Resize: the dragged edge follows the mouse; the opposite edge stays put.
      let { x, y, width, height } = st.startRect;
      if (st.dx === 1) {
        width = Math.max(minWidth, st.startRect.width + dxPx);
      } else if (st.dx === -1) {
        width = Math.max(minWidth, st.startRect.width - dxPx);
        x = st.startRect.x + (st.startRect.width - width);
      }
      if (st.dy === 1) {
        height = Math.max(minHeight, st.startRect.height + dyPx);
      } else if (st.dy === -1) {
        height = Math.max(minHeight, st.startRect.height - dyPx);
        y = st.startRect.y + (st.startRect.height - height);
      }
      setRect({ x, y, width, height });
    };

    const onUp = () => {
      if (!dragState.current) return;
      dragState.current = null;
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
  }, [minWidth, minHeight]);

  const beginInteraction = useCallback(
    (
      e: React.MouseEvent<HTMLElement>,
      mode: "move" | "resize",
      dx: -1 | 0 | 1,
      dy: -1 | 0 | 1,
    ) => {
      if (e.button !== 0) return;
      const start = currentRect();
      if (!start) return;
      e.preventDefault();
      e.stopPropagation();
      document.body.style.userSelect = "none";
      // Materialize so the CSS centering transform stops fighting the drag.
      setRect(start);
      dragState.current = {
        mode,
        dx,
        dy,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startRect: start,
      };
    },
    [currentRect],
  );

  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // Interactive elements in the header (close button etc.) keep their click.
      const target = e.target as HTMLElement;
      if (target.closest("button, input, select, textarea, a, [role='button']")) return;
      beginInteraction(e, "move", 0, 0);
    },
    [beginInteraction],
  );

  const resizeHandles = useMemo(() => {
    if (!resizable) return null;
    return (
      <>
        {HANDLES.map(([name, dx, dy, cursor]) => (
          <div
            key={name}
            style={handleStyle(name, cursor)}
            onMouseDown={(e) => beginInteraction(e, "resize", dx, dy)}
          />
        ))}
      </>
    );
  }, [resizable, beginInteraction]);

  const style = useMemo<React.CSSProperties>(() => {
    if (!rect) return {};
    return {
      // position:fixed also covers boxes that were centered by a flex
      // backdrop (static position) — coordinates came from the viewport rect,
      // so popping out of flow is visually seamless.
      position: "fixed",
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      // Defeat percentage/transform centering once the user takes control.
      right: "auto",
      bottom: "auto",
      transform: "none",
      margin: 0,
      maxWidth: "none",
      maxHeight: "none",
    };
  }, [rect]);

  return { ref, style, onHeaderMouseDown, resizeHandles, reset };
}
