//! FILENAME: app/extensions/_shared/components/ActivityDot.tsx
// PURPOSE: An indicator that is visibly ALIVE, so a slow local model reads as
//          working rather than wedged.
// CONTEXT: 2026-08-24, asked for directly: "it would be cool to have an icon
//          that is alive". The substance behind the ask is real — on a CPU-bound
//          7B a single round takes a minute or more, and a static label is
//          indistinguishable from a frozen one.
//
//          WHY ANIMATION AND NOT A PERCENTAGE. There is no honest percentage
//          here: the run ends when a draft passes, which may be attempt 1 or
//          attempt 7, and a bar that crawls to 90% and sits there is a worse lie
//          than no bar. Continuous motion claims exactly one thing — "this
//          process is still alive" — which is the thing that is actually known.
//
//          CSS KEYFRAMES, INJECTED ONCE. An interval driving React state would
//          re-render the whole pane several times a second for a decoration, and
//          would freeze at exactly the moment it matters most: when the main
//          thread is busy. A CSS animation runs on the compositor and keeps
//          moving through a busy tick, which is the honest signal.
//
//          IN _shared BECAUSE TWO EXTENSIONS SHOW IT. AIChat drives it from the
//          job store; the Object Script Editor (ScriptableObjects) shows the
//          same signal for the same runs, in a different window. Extensions may
//          not import each other, and a copy would drift the moment one of them
//          is retuned.

import React, { useEffect } from "react";

const STYLE_ID = "calcula-aichat-activity-keyframes";

/**
 * Inject the keyframes once per document.
 *
 * Guarded by id rather than a module flag: the Object Script Editor is a
 * SEPARATE Tauri window with its own document, and a module-level `injected`
 * boolean would leave the second window's animation dead.
 */
function useKeyframes(): void {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "@keyframes calcula-aichat-pulse {",
      "  0%   { transform: scale(0.75); opacity: 0.45; }",
      "  50%  { transform: scale(1.15); opacity: 1; }",
      "  100% { transform: scale(0.75); opacity: 0.45; }",
      "}",
      "@keyframes calcula-aichat-spin {",
      "  from { transform: rotate(0deg); }",
      "  to   { transform: rotate(360deg); }",
      "}",
      // Respect the OS setting: motion is a signal, not a requirement, and a
      // user who has asked for less of it still gets the colour and the label.
      "@media (prefers-reduced-motion: reduce) {",
      "  .calcula-aichat-alive, .calcula-aichat-ring { animation: none !important; }",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }, []);
}

export type ActivityStatus = "running" | "done" | "failed" | "idle";

const COLOUR: Record<ActivityStatus, string> = {
  running: "#0078D4",
  done: "#2E7D32",
  failed: "#C62828",
  idle: "#9E9E9E",
};

export interface ActivityDotProps {
  status: ActivityStatus;
  /** Pixel diameter of the dot itself. The ring scales with it. */
  size?: number;
  title?: string;
  /**
   * Override the status colour.
   *
   * The status bar is Excel green with white text, so the blue that reads well
   * in the pane is nearly invisible there. The CALLER knows what it is sitting
   * on; this component does not.
   */
  color?: string;
}

/** A pulsing dot inside a rotating ring while running; a still dot otherwise. */
export function ActivityDot(props: ActivityDotProps): React.ReactElement {
  useKeyframes();
  const size = props.size ?? 10;
  const ring = size * 2;
  const colour = props.color ?? COLOUR[props.status];
  const running = props.status === "running";

  return React.createElement(
    "span",
    {
      title: props.title,
      // `aria-live` is deliberately absent: the animation is decoration, and the
      // phase text beside it is the thing a screen reader should read.
      role: "img",
      "aria-label": running ? "working" : props.status,
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: ring,
        height: ring,
        position: "relative",
        flexShrink: 0,
      },
    },
    running
      ? React.createElement("span", {
          key: "ring",
          className: "calcula-aichat-ring",
          style: {
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `1.5px solid ${colour}`,
            // A gap in the ring is what makes the rotation visible at all.
            borderRightColor: "transparent",
            borderTopColor: "transparent",
            animation: "calcula-aichat-spin 1.1s linear infinite",
          },
        })
      : null,
    React.createElement("span", {
      key: "dot",
      className: running ? "calcula-aichat-alive" : undefined,
      style: {
        width: size,
        height: size,
        borderRadius: "50%",
        background: colour,
        animation: running ? "calcula-aichat-pulse 1.4s ease-in-out infinite" : undefined,
      },
    }),
  );
}
