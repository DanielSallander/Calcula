//! FILENAME: app/extensions/AIChat/components/AuthorStatusItem.tsx
// PURPOSE: Show a running authoring job in the status bar, so "go and do
//          something else" does not mean "lose sight of it".
// CONTEXT: 2026-08-24. The job survives the pane closing (`lib/authorJobs.ts`),
//          which is only half the ask — the other half is knowing it is still
//          working without going back to look. This renders nothing at all when
//          nothing is running, so it costs a user who never authors a script
//          exactly one empty span.

import React, { useState, useSyncExternalStore } from "react";
import { subscribeToJobs, runningJobs, formatElapsed } from "../lib/authorJobs";
import { ActivityDot } from "./ActivityDot";

const wrap: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px",
  fontSize: 11,
  color: "#24547E",
  whiteSpace: "nowrap",
  maxWidth: 340,
  overflow: "hidden",
};

const phaseStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Snapshot of the running set. Stable identity while nothing changes. */
function useRunning() {
  return useSyncExternalStore(subscribeToJobs, runningJobs, runningJobs);
}

export function AuthorStatusItem(): React.ReactElement | null {
  const running = useRunning();
  const job = running[0];

  // The elapsed clock needs its own tick; the store only emits on real changes,
  // and a phase can legitimately last a minute on a local model.
  const [, setTick] = useState(0);
  React.useEffect(() => {
    if (!job) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [job?.id]);

  if (!job) return null;

  const extra = running.length > 1 ? ` (+${running.length - 1})` : "";
  return React.createElement(
    "span",
    { style: wrap, title: `${job.intent}\n${job.phase}` },
    React.createElement(ActivityDot, { key: "dot", status: "running", size: 7 }),
    React.createElement("span", { key: "p", style: phaseStyle }, `${job.phase}${extra}`),
    React.createElement(
      "span",
      { key: "t", style: { color: "#5C7FA3", fontVariantNumeric: "tabular-nums" } },
      formatElapsed(Date.now() - job.startedAt),
    ),
  );
}
