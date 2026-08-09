//! FILENAME: app/extensions/Animation/overlay/PlayPill.tsx
// PURPOSE: The Animation play pill — a VIEWPORT-PINNED floating transport
//          (play/pause + progress + frame count + close) shown while a driver is
//          loaded.
//
// WHY IT IS NOT ON THE GRID ANY MORE (open-decisions-2026-08.md §2q / D4).
//   The pill used to be a floating GRID REGION anchored at a fixed SHEET
//   position near the origin, which put a 172x26 hit-testable control on top of
//   A1:C2 — the three cells most likely to be clicked in any workbook. It ate
//   the click instead of selecting the cell, in the product and across
//   eighty-nine E2E spec files. A control that lives in cell coordinates
//   competes with the data for the one resource the grid cannot spare, so the
//   pill now lives in the CHROME: it is a DOM overlay registered through
//   @api/ui's overlay registry (the same route AutoFilter's dropdown and
//   CellBookmarks' editors use), positioned over the grid canvas's bottom-left
//   corner. It claims NO grid coordinates and is not hit-tested by the grid at
//   all, so a click at A1 is a click at A1.
//
// WHY BOTTOM-LEFT OF THE CANVAS, AND WHY MEASURED FROM THE CANVAS.
//   Bottom-left is where Office puts transient document chrome (Word's focus /
//   reading transports, PowerPoint's slideshow bar) — parity with Excel is not
//   available here because Excel has no playback transport at all, so the house
//   convention is the next authority. Measuring from the live grid canvas rect
//   rather than from the window is what keeps it out of the panel/layout
//   system's way: opening the sidebar, the task pane or the ribbon resizes the
//   canvas, and the pill simply follows it instead of overlapping whatever the
//   layout put there.
//
// TRANSIENCE. This component only reads engine state and calls play/pause/
//   clearDriver. Frames themselves stay on the transient-write path
//   (anim_apply_frame under a filed snapshot token); nothing here writes cells.

import React, { useCallback, useEffect, useState } from "react";
import { getGridCanvas } from "@api/rendering";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { PlayIcon, PauseIcon } from "../components/icons";
import {
  pillPosition,
  PILL_MARGIN,
  PILL_FALLBACK_BOTTOM,
  PILL_Z_INDEX,
  type PillPosition,
} from "./pillGeometry";

function measure(): PillPosition {
  if (typeof window === "undefined") {
    return { left: PILL_MARGIN, bottom: PILL_FALLBACK_BOTTOM };
  }
  const canvas = getGridCanvas();
  const rect = canvas ? canvas.getBoundingClientRect() : null;
  return pillPosition(rect, window.innerHeight);
}

/**
 * Track the grid canvas's bottom-left corner. A ResizeObserver on the canvas
 * covers every layout change that matters — opening/closing a side panel, the
 * task pane, collapsing the ribbon and resizing the window all resize the
 * canvas — with a window `resize` listener as the belt-and-braces path for the
 * case where the canvas moves without changing size.
 */
function usePillPosition(): PillPosition {
  const [pos, setPos] = useState<PillPosition>(measure);

  useEffect(() => {
    const update = (): void => setPos(measure());
    update();
    window.addEventListener("resize", update);
    let observer: ResizeObserver | undefined;
    const canvas = getGridCanvas();
    if (canvas && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(canvas);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);

  return pos;
}

const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  flex: "0 0 auto",
};

/**
 * The pill itself. Registered as a DOM overlay; the overlay registry decides
 * when it is mounted (see playOverlay.ts), and it renders nothing when no driver
 * is loaded so a stale `showOverlay` can never leave an empty pill on screen.
 */
export function PlayPill(): React.ReactElement | null {
  const [state, setState] = useState<EngineState>(() => playbackEngine.getState());
  useEffect(() => playbackEngine.subscribe(setState), []);
  const pos = usePillPosition();

  const isPlaying = state.status === "playing";
  const toggle = useCallback(() => {
    if (playbackEngine.getState().status === "playing") playbackEngine.pause();
    else playbackEngine.play();
  }, []);
  const close = useCallback(() => {
    void playbackEngine.clearDriver();
  }, []);

  if (state.frameCount === 0) return null;

  const span = Math.max(1, state.rangeEnd - state.rangeStart);
  const progress = Math.max(0, Math.min(1, (state.frame - state.rangeStart) / span));

  return (
    <div
      data-testid="anim-play-pill"
      role="group"
      aria-label="Animation playback"
      style={{
        position: "fixed",
        left: pos.left,
        bottom: pos.bottom,
        zIndex: PILL_Z_INDEX,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 28,
        padding: "0 6px 0 8px",
        borderRadius: 14,
        border: "1px solid var(--border-color, #d0d0d0)",
        background: "var(--panel-bg, #ffffff)",
        color: "var(--text-primary, #1f1f1f)",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.18)",
        font: "11px/1 system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      <button
        type="button"
        data-testid="anim-pill-toggle"
        title={isPlaying ? "Pause animation" : "Play animation"}
        aria-label={isPlaying ? "Pause animation" : "Play animation"}
        onClick={toggle}
        style={{ ...buttonStyle, color: "var(--accent-color, #217346)" }}
      >
        {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
      </button>

      <div
        aria-hidden="true"
        style={{
          width: 76,
          height: 4,
          borderRadius: 2,
          background: "var(--bg-surface-disabled, #e6e6e6)",
          overflow: "hidden",
          flex: "0 0 auto",
        }}
      >
        <div
          data-testid="anim-pill-progress"
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: "var(--accent-color, #217346)",
          }}
        />
      </div>

      <span
        data-testid="anim-pill-frame"
        style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", opacity: 0.85 }}
      >
        {state.frame + 1}/{state.frameCount}
      </span>

      <button
        type="button"
        data-testid="anim-pill-close"
        title="Unload the animation driver (restores the model and hides this control)"
        aria-label="Unload animation driver"
        onClick={close}
        style={buttonStyle}
      >
        <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3.5 3.5l9 9m0-9l-9 9"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
