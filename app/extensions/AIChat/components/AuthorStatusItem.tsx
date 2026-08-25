//! FILENAME: app/extensions/AIChat/components/AuthorStatusItem.tsx
// PURPOSE: Show a running authoring job in the status bar, and be the way back
//          to it.
// CONTEXT: 2026-08-25. The first cut was BLUE-ON-GREEN and barely legible: the
//          status bar is Excel green (`#217346`, `src/shell/StatusBar.tsx`) with
//          white text, and this item had been styled for the pane's white
//          background. Everything here is therefore expressed against that
//          green — white text, a white dot, and a translucent-white hover —
//          rather than against a palette from somewhere else.
//
//          It was also inert. Proving a job is alive without offering a way to
//          reach it just moves the work to the user, so the whole strip is a
//          button now: `requestJobView()` opens the pane and switches it to the
//          guided screen.
//
//          Renders NOTHING when nothing is running, so a user who never authors
//          a script pays one empty span.

import React, { useState, useSyncExternalStore } from "react";
import { subscribeToJobs, runningJobs, formatElapsed } from "../lib/authorJobs";
import { requestJobView } from "../lib/jobFocus";
import { ActivityDot } from "../../_shared/components/ActivityDot";

/** The status bar's own text colour. Anything dimmer disappears on the green. */
const ON_GREEN = "#FFFFFF";
/** Secondary text. White at reduced opacity keeps contrast without a new hue. */
const ON_GREEN_DIM = "rgba(255, 255, 255, 0.78)";

const base: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px",
  height: "100%",
  fontSize: 11,
  color: ON_GREEN,
  whiteSpace: "nowrap",
  maxWidth: 340,
  overflow: "hidden",
  cursor: "pointer",
  // Reset the UA button look: this sits inside the shell's own bar and must not
  // bring a grey box and a border with it.
  background: "transparent",
  border: "none",
  font: "inherit",
  fontFamily: "inherit",
};

const phaseStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Snapshot of the running set. Memoised in the store, so its identity is stable. */
function useRunning() {
  return useSyncExternalStore(subscribeToJobs, runningJobs, runningJobs);
}

export function AuthorStatusItem(): React.ReactElement | null {
  const running = useRunning();
  const [hover, setHover] = useState(false);
  const job = running[0];

  // The elapsed clock needs its own tick; the store only emits on real changes,
  // and a phase can legitimately last several minutes on a local model.
  const [, setTick] = useState(0);
  React.useEffect(() => {
    if (!job) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [job?.id]);

  if (!job) return null;

  const extra = running.length > 1 ? ` (+${running.length - 1})` : "";
  return React.createElement(
    "button",
    {
      type: "button",
      style: { ...base, background: hover ? "rgba(255,255,255,0.16)" : "transparent" },
      title: `${job.intent}\n${job.phase}\n\nClick to open the script job.`,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onClick: () => requestJobView(),
    },
    React.createElement(ActivityDot, { key: "dot", status: "running", size: 7, color: ON_GREEN }),
    React.createElement("span", { key: "p", style: phaseStyle }, `${job.phase}${extra}`),
    React.createElement(
      "span",
      { key: "t", style: { color: ON_GREEN_DIM, fontVariantNumeric: "tabular-nums" } },
      formatElapsed(Date.now() - job.startedAt),
    ),
  );
}
