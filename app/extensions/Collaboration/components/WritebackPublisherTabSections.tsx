// FILENAME: app/extensions/Collaboration/components/WritebackPublisherTabSections.tsx
// PURPOSE: The contextual "Writeback" ribbon tab as the PUBLISHER sees it: three
//          clusters -- Region, Status, Responses -- for the writeback region this
//          workbook designated under Core's active cell.
// CONTEXT: The same tab (id `writeback-tab`, label "Writeback") as the
//          subscriber's (WritebackTabSections.tsx); lib/writebackTab.ts registers
//          this section list instead when the cursor is in one of the workbook's
//          OWN designated regions (a fresh workbook or a working copy) rather
//          than a subscribed one. No Submit, no drafts: the publisher collects,
//          the subscriber sends.
//
//          Built only from @api/layout (no CSS colours: the hex ban in
//          app/eslint.boundaries.js covers this file). Every mounted copy reads
//          the shared writeback snapshot and the tab model through
//          useSyncExternalStore. FILL RULE: Region and Responses are one tall row
//          of heroes ("inline"); Status is two 28px rows in a ControlGrid.

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
import type { WritebackRegionDeclaration } from "@api/collaboration";
import {
  subscribeWritebackSnapshot,
  getWritebackSnapshotVersion,
  getDesignatedRegion,
} from "../lib/writebackStore";
import {
  subscribeWritebackTabState,
  getWritebackTabStateVersion,
  getWritebackPublisherRegionId,
  isWritebackActionBusy,
  publisherStatusLinesFor,
  editDesignatedRegion,
  removeDesignatedRegion,
  openCollectedResponses,
  openWritebackPane,
  type WritebackStatusLine,
} from "../lib/writebackTabModel";

interface PublisherTabView {
  region: WritebackRegionDeclaration | null;
  busy: boolean;
}

function usePublisherTabView(): PublisherTabView {
  useSyncExternalStore(subscribeWritebackSnapshot, getWritebackSnapshotVersion, getWritebackSnapshotVersion);
  useSyncExternalStore(subscribeWritebackTabState, getWritebackTabStateVersion, getWritebackTabStateVersion);
  const id = getWritebackPublisherRegionId();
  return { region: id ? getDesignatedRegion(id) : null, busy: isWritebackActionBusy() };
}

const NO_REGION = "Select a cell in one of this workbook's writeback regions";

// ============================================================================
// 1. Region
// ============================================================================

export function WritebackPublisherRegionSection(_props: PanelSectionProps): React.ReactElement {
  const { region, busy } = usePublisherTabView();
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Pencil size={HERO_ICON_SIZE} />}
        label="Edit Region"
        labelLines={2}
        disabled={!region || busy}
        title={region ? "Change what this region accepts, who sees it and when values are sent" : NO_REGION}
        data-testid="writeback-tab-edit-region"
        onClick={() => {
          if (region) editDesignatedRegion(region.id);
        }}
      />
      <CommandButton
        icon={<RibbonIcon.Delete size={HERO_ICON_SIZE} />}
        label="Remove Region"
        labelLines={2}
        disabled={!region || busy}
        title={region ? "Stop collecting values for these cells (from your next publish or push)" : NO_REGION}
        data-testid="writeback-tab-remove-region"
        onClick={() => {
          if (!region) return;
          removeDesignatedRegion(region.id).catch((err) =>
            console.error("[WritebackTab] Remove Region failed:", err),
          );
        }}
      />
    </ActionRow>
  );
}

// ============================================================================
// 2. Status
// ============================================================================

function StatusLine({ line, icon, testId }: { line: WritebackStatusLine; icon: React.ReactElement; testId: string }): React.ReactElement {
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
        maxWidth: 300,
        color: LT.textSecondary,
      }}
    >
      <span aria-hidden style={{ display: "inline-flex", flex: "none" }}>
        {icon}
      </span>
      <StatusText title={line.text}>{line.text}</StatusText>
    </div>
  );
}

export function WritebackPublisherStatusSection(_props: PanelSectionProps): React.ReactElement {
  const { region } = usePublisherTabView();
  const [what, who] = region
    ? publisherStatusLinesFor(region)
    : [
        { tone: "info" as const, text: NO_REGION },
        { tone: "info" as const, text: "" },
      ];
  return (
    <ControlGrid>
      <StatusLine line={what} icon={<RibbonIcon.Info size={ICON_SIZE_SM} />} testId="writeback-tab-publisher-region" />
      <ControlGridBreak />
      <StatusLine line={who} icon={<RibbonIcon.Eye size={ICON_SIZE_SM} />} testId="writeback-tab-publisher-visibility" />
    </ControlGrid>
  );
}

// ============================================================================
// 3. Responses
// ============================================================================

export function WritebackPublisherResponsesSection(_props: PanelSectionProps): React.ReactElement {
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Table size={HERO_ICON_SIZE} />}
        label="Collected Responses"
        labelLines={2}
        title="Review what subscribers sent: approve or reject, see who has not answered, export"
        data-testid="writeback-tab-collected-responses"
        onClick={openCollectedResponses}
      />
      <CommandButton
        icon={<RibbonIcon.Sidebar size={HERO_ICON_SIZE} />}
        label="Writeback Pane"
        labelLines={2}
        title="Open the Writeback pane: every region this workbook designated"
        data-testid="writeback-tab-publisher-open-pane"
        onClick={openWritebackPane}
      />
    </ActionRow>
  );
}

// ============================================================================
// Section list
// ============================================================================

/** Ids are prefixed by the panel id; Status demotes to a launcher first. */
export const WRITEBACK_PUBLISHER_TAB_SECTIONS: PanelSection[] = [
  {
    id: "writeback-tab.region",
    label: "Region",
    icon: <RibbonIcon.Pencil size={ICON_SIZE_MD} />,
    component: WritebackPublisherRegionSection,
    ribbonPresentation: "inline",
    collapsePriority: 50,
  },
  {
    id: "writeback-tab.region-status",
    label: "Status",
    icon: <RibbonIcon.Info size={ICON_SIZE_MD} />,
    component: WritebackPublisherStatusSection,
    collapsePriority: 10,
  },
  {
    id: "writeback-tab.collected",
    label: "Responses",
    icon: <RibbonIcon.Table size={ICON_SIZE_MD} />,
    component: WritebackPublisherResponsesSection,
    ribbonPresentation: "inline",
    collapsePriority: 100,
  },
];
