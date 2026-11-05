//! FILENAME: app/src/api/layout/primitives/focusRescue.ts
// PURPOSE: Keep keyboard focus when a split button's open menu or palette is
//          torn down because the control was DISABLED under it (BUG-0398).
// CONTEXT: SplitMenuButton (Menu.tsx) and ColorSwatch's split form (Color.tsx)
//          close their overlay the moment `disabled` turns true -- Merge &
//          Center computes it asynchronously from protection, table regions and
//          editing, so it can flip while the user is in the menu. The overlay
//          unmounts with the focused row inside it, and a browser whose focused
//          element is removed puts focus on <body>: the keyboard user is
//          nowhere, and the next Tab starts from the top of the page. Escape and
//          a pick already hand focus back to the half that opened the overlay;
//          a disable must too. The halves are aria-disabled, never natively
//          disabled, so they can still take focus (see SplitMenuButton).
//
//          ONLY a focus the overlay HELD is rescued. A disable while focus is
//          elsewhere (the user clicked into the grid with the menu open) leaves
//          it there.

import { useCallback, useLayoutEffect, useRef } from "react";
import type React from "react";

/** The focus handlers to put on the overlay's content (React's focus events
 *  bubble through the portal the popover renders into). */
export interface FocusRescueHandlers {
  onFocus: (e: React.FocusEvent) => void;
  onBlur: (e: React.FocusEvent) => void;
}

/**
 * Track whether focus is inside an overlay, and when `disabled` closes it with
 * focus inside -- which leaves `document.activeElement` on <body> -- focus
 * `target()` instead (the half that opened it).
 */
export function useFocusRescueOnDisable(
  disabled: boolean | undefined,
  target: () => HTMLElement | null | undefined,
): FocusRescueHandlers {
  const inside = useRef(false);
  const targetRef = useRef(target);
  // Declared before the rescue below, so it runs first in the same commit.
  useLayoutEffect(() => {
    targetRef.current = target;
  });

  const onFocus = useCallback(() => {
    inside.current = true;
  }, []);
  const onBlur = useCallback(() => {
    // Moving between rows: the next focus is still inside, and its own focus
    // event sets the flag again right after this one clears it.
    inside.current = false;
  }, []);

  // A layout effect runs after the commit that removed the overlay and before
  // the browser paints, so no frame shows focus lost. A REMOVED element fires
  // no blur, which is why `inside` still says where focus was.
  useLayoutEffect(() => {
    if (!disabled || !inside.current) return;
    inside.current = false;
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    targetRef.current()?.focus();
  }, [disabled]);

  return { onFocus, onBlur };
}
