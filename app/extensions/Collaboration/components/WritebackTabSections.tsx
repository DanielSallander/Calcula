// FILENAME: app/extensions/Collaboration/components/WritebackTabSections.tsx
// PURPOSE: The contextual "Writeback" ribbon tab's four clusters -- Submit,
//          Drafts, Status, Responses -- for the writeback region under Core's
//          active cell.
// CONTEXT: Built only from @api/layout (no CSS colours: the hex ban in
//          app/eslint.boundaries.js covers this file). Each section can mount
//          up to three times (band, launcher flyout, sidebar), so every copy
//          reads the SAME two stores through useSyncExternalStore: the shared
//          writeback snapshot (counts, states) and the tab model (which region
//          is under the cursor, whether an action is running). A disabled
//          button gets no pointer events, so the reason it is disabled rides on
//          a native `title` (the TableDesignTab idiom), visible either way.
//
//          FILL RULE: Submit, Drafts and Responses are one tall row of heroes
//          (61px, "inline"); Status is two 28px rows (state, then who sees the
//          input) in a ControlGrid.

import React, { useSyncExternalStore } from "react";
import { RibbonIcon } from "@api/ribbonIcons";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  StatusText,
  LT,
  GAP_XS,
  CONTROL_HEIGHT_MD,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  ICON_SIZE_MD,
} from "@api/layout";
import {
  subscribeWritebackSnapshot,
  getWritebackSnapshotVersion,
  getRegionSummary,
  totalUnsentDrafts,
  type WritebackRegionSummary,
} from "../lib/writebackStore";
import {
  subscribeWritebackTabState,
  getWritebackTabStateVersion,
  getWritebackTabRegionId,
  isWritebackActionBusy,
  submitButtonState,
  submitAllButtonState,
  discardButtonState,
  statusLinesFor,
  submitWritebackRegion,
  submitAllWriteback,
  discardWritebackRegionDrafts,
  checkWritebackStatus,
  openWritebackPane,
  countText,
  type WritebackStatusLine,
  type WritebackStatusTone,
} from "../lib/writebackTabModel";

// ============================================================================
// Shared view
// ============================================================================

interface WritebackTabView {
  summary: WritebackRegionSummary | null;
  totalUnsent: number;
  busy: boolean;
}

/** Re-render on any snapshot or tab-state change; derive the view fresh. */
function useWritebackTabView(): WritebackTabView {
  useSyncExternalStore(subscribeWritebackSnapshot, getWritebackSnapshotVersion, getWritebackSnapshotVersion);
  useSyncExternalStore(subscribeWritebackTabState, getWritebackTabStateVersion, getWritebackTabStateVersion);
  const regionId = getWritebackTabRegionId();
  return {
    summary: regionId ? getRegionSummary(regionId) : null,
    totalUnsent: totalUnsentDrafts(),
    busy: isWritebackActionBusy(),
  };
}

function report(err: unknown, action: string): void {
  console.error(`[WritebackTab] ${action} failed:`, err);
}

// ============================================================================
// 1. Submit
// ============================================================================

export function WritebackSubmitSection(_props: PanelSectionProps): React.ReactElement {
  const { summary, totalUnsent, busy } = useWritebackTabView();
  const one = submitButtonState(summary);
  const all = submitAllButtonState(totalUnsent);
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Upload size={HERO_ICON_SIZE} />}
        label="Submit"
        badge={summary && summary.draftCount > 0 ? countText(summary.draftCount) : undefined}
        disabled={one.disabled || busy}
        title={one.tooltip}
        data-testid="writeback-tab-submit"
        onClick={() => {
          if (!summary) return;
          submitWritebackRegion(summary.regionId).catch((err) => report(err, "Submit"));
        }}
      />
      <CommandButton
        icon={<RibbonIcon.Upload size={HERO_ICON_SIZE} />}
        label="Submit All"
        disabled={all.disabled || busy}
        title={all.tooltip}
        data-testid="writeback-tab-submit-all"
        onClick={() => {
          submitAllWriteback().catch((err) => report(err, "Submit All"));
        }}
      />
    </ActionRow>
  );
}

// ============================================================================
// 2. Drafts
// ============================================================================

export function WritebackDraftsSection(_props: PanelSectionProps): React.ReactElement {
  const { summary, busy } = useWritebackTabView();
  const discard = discardButtonState(summary);
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Delete size={HERO_ICON_SIZE} />}
        label="Discard Drafts"
        labelLines={2}
        disabled={discard.disabled || busy}
        title={discard.tooltip}
        data-testid="writeback-tab-discard"
        onClick={() => {
          if (!summary) return;
          discardWritebackRegionDrafts(summary.regionId).catch((err) => report(err, "Discard Drafts"));
        }}
      />
    </ActionRow>
  );
}

// ============================================================================
// 3. Status
// ============================================================================

const TONE_COLOR: Record<WritebackStatusTone, string> = {
  warn: LT.warnFg,
  danger: LT.dangerFg,
  ok: LT.okFg,
  info: LT.textSecondary,
};

function toneIcon(tone: WritebackStatusTone): React.ReactElement {
  switch (tone) {
    case "warn":
      return <RibbonIcon.Warn size={ICON_SIZE_SM} />;
    case "danger":
      return <RibbonIcon.Error size={ICON_SIZE_SM} />;
    case "ok":
      return <RibbonIcon.Success size={ICON_SIZE_SM} />;
    case "info":
    default:
      return <RibbonIcon.Info size={ICON_SIZE_SM} />;
  }
}

/** One 28px status row: a tone icon and its sentence. */
function StatusLine({
  line,
  icon,
  testId,
}: {
  line: WritebackStatusLine;
  icon?: React.ReactElement;
  testId: string;
}): React.ReactElement {
  return (
    <div
      data-testid={testId}
      data-tone={line.tone}
      style={{
        display: "flex",
        alignItems: "center",
        gap: GAP_XS,
        height: CONTROL_HEIGHT_MD,
        minWidth: 0,
        maxWidth: 280,
        color: TONE_COLOR[line.tone],
      }}
    >
      <span aria-hidden style={{ display: "inline-flex", flex: "none" }}>
        {icon ?? toneIcon(line.tone)}
      </span>
      <StatusText title={line.text}>
        <span style={{ color: TONE_COLOR[line.tone] }}>{line.text}</span>
      </StatusText>
    </div>
  );
}

export function WritebackStatusSection(_props: PanelSectionProps): React.ReactElement {
  const { summary } = useWritebackTabView();
  if (!summary) {
    return (
      <ControlGrid>
        <StatusLine
          line={{ tone: "info", text: "Select a cell in a writeback region" }}
          testId="writeback-tab-status-state"
        />
        <ControlGridBreak />
        <StatusLine line={{ tone: "info", text: "" }} testId="writeback-tab-status-visibility" />
      </ControlGrid>
    );
  }
  const [state, visibility] = statusLinesFor(summary);
  return (
    <ControlGrid>
      <StatusLine line={state} testId="writeback-tab-status-state" />
      <ControlGridBreak />
      <StatusLine
        line={visibility}
        icon={<RibbonIcon.Eye size={ICON_SIZE_SM} />}
        testId="writeback-tab-status-visibility"
      />
    </ControlGrid>
  );
}

// ============================================================================
// 4. Responses
// ============================================================================

export function WritebackResponsesSection(_props: PanelSectionProps): React.ReactElement {
  const { busy } = useWritebackTabView();
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Refresh size={HERO_ICON_SIZE} />}
        label="Check Status"
        labelLines={2}
        disabled={busy}
        title="Ask the workspace whether the publisher has approved or rejected what you sent"
        data-testid="writeback-tab-check-status"
        onClick={() => {
          checkWritebackStatus().catch((err) => report(err, "Check Status"));
        }}
      />
      <CommandButton
        icon={<RibbonIcon.Sidebar size={HERO_ICON_SIZE} />}
        label="Writeback Pane"
        labelLines={2}
        title="Open the Writeback pane: every region, each value's state, and the publisher's checks"
        data-testid="writeback-tab-open-pane"
        onClick={openWritebackPane}
      />
    </ActionRow>
  );
}

// ============================================================================
// Section list
// ============================================================================

/** Ids are prefixed by the panel id; Status demotes to a launcher first. */
export const WRITEBACK_TAB_SECTIONS: PanelSection[] = [
  {
    id: "writeback-tab.submit",
    label: "Submit",
    icon: <RibbonIcon.Upload size={ICON_SIZE_MD} />,
    component: WritebackSubmitSection,
    ribbonPresentation: "inline",
    collapsePriority: 100,
  },
  {
    id: "writeback-tab.drafts",
    label: "Drafts",
    icon: <RibbonIcon.Delete size={ICON_SIZE_MD} />,
    component: WritebackDraftsSection,
    ribbonPresentation: "inline",
    collapsePriority: 50,
  },
  {
    id: "writeback-tab.status",
    label: "Status",
    icon: <RibbonIcon.Info size={ICON_SIZE_MD} />,
    component: WritebackStatusSection,
    collapsePriority: 10,
  },
  {
    id: "writeback-tab.responses",
    label: "Responses",
    icon: <RibbonIcon.Refresh size={ICON_SIZE_MD} />,
    component: WritebackResponsesSection,
    ribbonPresentation: "inline",
    collapsePriority: 40,
  },
];
