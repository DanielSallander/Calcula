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
import {
  workingCopyStatus,
  getSubscriptions,
  AppEvents,
  onAppEvent,
  openPanel,
  ENVIRONMENTS_CHANGED_EVENT,
} from "@api";
import { formatSubscriptionTarget } from "../lib/environments";
import { APPLICATION_EXPLORER_PANEL_ID } from "../manifest";
import {
  SUBSCRIBED_CHIP,
  WORKING_COPY_CHIP,
  WORKING_COPY_STALE_CHIP,
} from "../lib/roleChipColors";

interface Role {
  workingCopy: WorkingCopyStatus | null;
  subscriptions: Array<{
    packageName: string;
    resolvedVersion: string;
    environment?: string | null;
  }>;
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
      // A promotion, a pipeline edit, or a switch in the Subscriptions pane all
      // change what this chip should say without any document event firing.
      onAppEvent(ENVIRONMENTS_CHANGED_EVENT, () => void reload()),
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
          .map(
            (s) =>
              `"${formatSubscriptionTarget(s.packageName, s.environment)}" ` +
              `v${s.resolvedVersion}`,
          )
          .join(", ")}. A subscribed copy can never push to the application it came from.`
      : null,
    "Click to open the Application Explorer.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <div style={wrap} onClick={open} title={title} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") open(); }}>
      {/*
        Glyphs and colours come from lib/roleChipColors — the SAME constants the
        sheet-tab mark uses. Read seconds apart by the same person, so a green ↓
        here and something else on a tab would read as two different facts.
      */}
      {workingCopy && (
        <span
          style={chip(
            stale ? WORKING_COPY_STALE_CHIP.bg : WORKING_COPY_CHIP.bg,
            stale ? WORKING_COPY_STALE_CHIP.fg : WORKING_COPY_CHIP.fg,
          )}
        >
          {/* A pencil for "you may edit and push this" — the author side. */}
          {WORKING_COPY_CHIP.glyph} Working copy: {workingCopy.packageName} v
          {workingCopy.baseVersion}
          {stale ? " (behind)" : ""}
        </span>
      )}
      {subscriptions.length > 0 && (
        <span style={chip(SUBSCRIBED_CHIP.bg, SUBSCRIBED_CHIP.fg)}>
          {/* A down arrow for "this came from somewhere else" — read-only. */}
          {SUBSCRIBED_CHIP.glyph} Subscribed:{" "}
          {/* WHICH STREAM, not just which application. "sales v1.2.0" and
              "sales (prod) v1.2.0" answer different questions, and the second
              is the one a subscriber checks before believing a number. */}
          {subscriptions.length === 1
            ? `${formatSubscriptionTarget(
                subscriptions[0].packageName,
                subscriptions[0].environment,
              )} v${subscriptions[0].resolvedVersion}`
            : `${subscriptions.length} applications`}
        </span>
      )}
    </div>
  );
}
