// FILENAME: app/extensions/Distribution/components/DistributionRoleStatusItem.tsx
// PURPOSE: Say, at all times and without being opened, what this workbook IS to
//          the .calp world: a working copy you can push, a subscriber you never
//          can, or neither.
// CONTEXT: The three roles are exclusive PER APPLICATION and are the whole basis
//          of the push gates (docs/design/calp-workspace-collaboration.md §2.3) —
//          publishing from a subscribed copy is refused because it would orphan
//          every other subscriber's overrides. Until now the only place that said
//          which role you held was the Working copy section of the Application
//          Explorer, a sidebar you have to go and open. Two workbooks that look
//          identical on screen behave oppositely when you press Push, and a
//          developer testing both sides loses track of which window is which.
//
//          A workbook can hold BOTH roles at once — a working copy of one
//          application, a subscriber to another — so this renders both rather
//          than picking a winner.
//
//          Deliberately renders NOTHING for a plain workbook. A permanent
//          "Standalone" chip on every new file is noise, and the status bar is
//          shared real estate; the badge earns its place only when the answer is
//          non-obvious.

import React, { useCallback, useEffect, useState } from "react";
import type { WorkingCopyStatus } from "@api";
import { workingCopyStatus, getSubscriptions, AppEvents, onAppEvent, openPanel } from "@api";
import { APPLICATION_EXPLORER_PANEL_ID } from "../manifest";

interface Role {
  workingCopy: WorkingCopyStatus | null;
  subscriptions: Array<{ packageName: string; resolvedVersion: string }>;
}

const wrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "0 8px",
  height: "100%",
  cursor: "pointer",
  fontSize: "11px",
  whiteSpace: "nowrap",
};

const chip = (bg: string, fg: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "1px 6px",
  borderRadius: "9px",
  background: bg,
  color: fg,
  fontWeight: 600,
});

export function DistributionRoleStatusItem(): React.ReactElement | null {
  const [role, setRole] = useState<Role>({ workingCopy: null, subscriptions: [] });

  const reload = useCallback(async () => {
    // Independently settled: a workbook can legitimately have one role and not
    // the other, and a failure to read either must not blank the one that DID
    // answer — a badge that disappears on a transient error is worse than no
    // badge, because absence MEANS "standalone" here.
    const [wc, subs] = await Promise.allSettled([workingCopyStatus(), getSubscriptions()]);
    setRole({
      workingCopy: wc.status === "fulfilled" ? wc.value : null,
      subscriptions:
        subs.status === "fulfilled" ? (subs.value.subscriptions ?? []) : [],
    });
  }, []);

  useEffect(() => {
    void reload();
    // AFTER_OPEN/AFTER_NEW: the document was replaced, so the previous file's
    // role must not linger. PACKAGE_UPDATED: a pull, a refresh or a push landed.
    const offs = [
      onAppEvent(AppEvents.AFTER_OPEN, () => void reload()),
      onAppEvent(AppEvents.AFTER_NEW, () => void reload()),
      onAppEvent(AppEvents.PACKAGE_UPDATED, () => void reload()),
    ];
    return () => offs.forEach((off) => off());
  }, [reload]);

  const { workingCopy, subscriptions } = role;
  if (!workingCopy && subscriptions.length === 0) return null;

  const open = (): void => openPanel(APPLICATION_EXPLORER_PANEL_ID);

  // The stale marker matters more than the version: it is the difference between
  // a push that lands and one the base-version gate refuses.
  const stale = workingCopy?.isStale === true;

  const title = [
    workingCopy
      ? `Working copy of "${workingCopy.packageName}" — based on v${workingCopy.baseVersion}` +
        (stale ? `, and the workspace has moved on since. Pushing will ask you to merge.` : `. You can push changes back.`)
      : null,
    subscriptions.length > 0
      ? `Subscribed to ${subscriptions
          .map((s) => `"${s.packageName}" v${s.resolvedVersion}`)
          .join(", ")}. A subscribed copy can never push to the application it came from.`
      : null,
    "Click to open the Application Explorer.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <div style={wrap} onClick={open} title={title} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") open(); }}>
      {workingCopy && (
        <span style={chip(stale ? "#fef7e0" : "#e8f0fe", stale ? "#a05a00" : "#1a56b8")}>
          {/* A pencil for "you may edit and push this" — the author side. */}
          ✎ Working copy: {workingCopy.packageName} v{workingCopy.baseVersion}
          {stale ? " (behind)" : ""}
        </span>
      )}
      {subscriptions.length > 0 && (
        <span style={chip("#e8f5e9", "#137333")}>
          {/* A down arrow for "this came from somewhere else" — read-only. */}
          ↓ Subscribed:{" "}
          {subscriptions.length === 1
            ? `${subscriptions[0].packageName} v${subscriptions[0].resolvedVersion}`
            : `${subscriptions.length} applications`}
        </span>
      )}
    </div>
  );
}
