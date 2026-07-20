//! FILENAME: app/src/api/layout/primitives/Popover.tsx
// PURPOSE: Anchored popover host — positions arbitrary dropdown content below
//          an anchor element via a body portal, escaping any overflow:hidden
//          ancestor (the ribbon band clips its content, so in-band dropdowns
//          must not rely on position:absolute).
// CONTEXT: The positioning/dismissal half of the Launcher flyout, exposed as
//          its own primitive: galleries and custom dropdowns keep their own
//          chrome (background/border/shadow); Popover contributes fixed
//          positioning clamped to the viewport, Escape + outside-mousedown
//          dismissal, and the data-ribbon-content / data-section-flyout tags
//          the shell's outside-click guards recognize.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

export interface PopoverProps {
  /** Anchor the popover attaches below (usually the trigger's wrapper). */
  anchorEl: HTMLElement | null;
  open: boolean;
  /** Called on Escape or mousedown outside both popover and anchor. */
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Fixed-position dropdown host below `anchorEl`. Content is measured after
 * mount and the left edge clamped into the viewport; taller-than-viewport
 * content scrolls. Renders nothing while closed.
 */
export function Popover({ anchorEl, open, onClose, children }: PopoverProps): React.ReactElement | null {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position after first paint so the content's real width is measurable.
  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setPos(null);
      return;
    }
    const a = anchorEl.getBoundingClientRect();
    const w = popRef.current?.offsetWidth ?? 200;
    setPos({
      left: Math.max(4, Math.min(a.left, window.innerWidth - w - 4)),
      top: a.bottom + 2,
    });
  }, [open, anchorEl]);

  // Close on Escape and on mousedown outside both the popover and the anchor.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (popRef.current && popRef.current.contains(target)) return;
      if (anchorEl && anchorEl.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open, anchorEl, onClose]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed",
        left: pos?.left ?? 4,
        top: pos?.top ?? 0,
        zIndex: 1100,
        maxHeight: "80vh",
        maxWidth: "calc(100vw - 8px)",
        overflow: "auto",
        visibility: pos ? "visible" : "hidden",
      }}
      data-ribbon-content=""
      data-section-flyout=""
      role="dialog"
    >
      {children}
    </div>,
    document.body,
  );
}
