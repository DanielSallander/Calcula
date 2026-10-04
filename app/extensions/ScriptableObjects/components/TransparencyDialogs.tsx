//! FILENAME: app/extensions/ScriptableObjects/components/TransparencyDialogs.tsx
// PURPOSE: "Code in This File" and "Script Permissions" as DIALOG WINDOWS --
//          movable, resizable, modeless, like Insert Chart -- instead of side
//          panels folding out of the left edge.
// CONTEXT: Owner decision 2026-10-04. The two used to be sidebar panels (first
//          activity-bar icons, then hidden panels reached from the status
//          bar's code-and-scripts indicator). A panel squeezed a long inventory
//          and a 250-row policy table into the sidebar's width; a dialog gives
//          them room and opens where the user is looking. Every door -- the
//          indicator's popover, Developer, Settings > Script Security --
//          shows these by id (`showDialog`), so no caller imports this file.
//
//          The CONTENT is unchanged: the same sections the panels rendered
//          (CodeInThisFilePanel.tsx, PermissionsPanel.tsx), at their vertical
//          ("sidebar") geometry inside a scrolling body. Escape closes either
//          (DialogContainer's capture listener); the grid stays usable behind
//          them, as with Insert Chart.

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { FONT_FAMILY, IconButton, LT, SegmentedTabs } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { CodeInThisFileSection } from "./CodeInThisFilePanel";
import { ActivitySection, MountedScriptsSection, PolicyTableSection } from "./PermissionsPanel";

// ============================================================================
// The frame (Insert Chart's chrome, on the theme tokens)
// ============================================================================

const containerClass = css`
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 1051;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 95vw;
  max-height: 88vh;
  background: ${LT.panel};
  border: 1px solid ${LT.border};
  border-radius: 8px;
  box-shadow: ${LT.shadowPopover};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
`;

const headerClass = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 16px;
  flex-shrink: 0;
  cursor: grab;
  user-select: none;
  border-bottom: 1px solid ${LT.border};

  &:active {
    cursor: grabbing;
  }
`;

const titleClass = css`
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const iconClass = css`
  display: inline-flex;
  flex: none;
  width: 20px;
  height: 20px;
  color: ${LT.text};

  & svg {
    width: 20px;
    height: 20px;
  }
`;

const tabsClass = css`
  padding: 10px 16px 0;
  flex-shrink: 0;
`;

const bodyClass = css`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 12px;
`;

interface FrameProps {
  title: string;
  icon: React.ReactNode;
  /** Natural size; the user may drag-resize from there. */
  width: number;
  height: number;
  testId: string;
  onClose: () => void;
  /** Rendered between the header and the scrolling body (a tab bar). */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}

function TransparencyDialogFrame({
  title,
  icon,
  width,
  height,
  testId,
  onClose,
  toolbar,
  children,
}: FrameProps): React.ReactElement {
  const win = useDialogWindow({ minWidth: 420, minHeight: 320 });
  return (
    <div
      ref={win.ref}
      className={containerClass}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-testid={testId}
      style={{ width: `min(${width}px, 95vw)`, height: `min(${height}px, 88vh)`, ...win.style }}
    >
      <div className={headerClass} onMouseDown={win.onHeaderMouseDown}>
        <span className={iconClass} aria-hidden>
          {icon}
        </span>
        <span className={titleClass}>{title}</span>
        <IconButton
          size="md"
          label="Close"
          icon={<RibbonIcon.Close size={18} />}
          // The header drags the window; a press on Close must not start one.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        />
      </div>
      {toolbar && <div className={tabsClass}>{toolbar}</div>}
      <div className={bodyClass}>{children}</div>
      {win.resizeHandles}
    </div>
  );
}

// ============================================================================
// The two dialogs
// ============================================================================

/** The two dialogs' icons, passed in by the extension (one drawing each). */
export interface TransparencyDialogIcons {
  code: React.ReactNode;
  permissions: React.ReactNode;
}

/** Code in This File: the whole inventory, one scrolling body. */
export function createCodeInThisFileDialog(icons: TransparencyDialogIcons): React.ComponentType<DialogProps> {
  function CodeInThisFileDialog({ isOpen, onClose }: DialogProps): React.ReactElement | null {
    if (!isOpen) return null;
    return (
      <TransparencyDialogFrame
        title="Code in This File"
        icon={icons.code}
        width={760}
        height={700}
        testId="code-in-this-file-dialog"
        onClose={onClose}
      >
        <CodeInThisFileSection placement="sidebar" />
      </TransparencyDialogFrame>
    );
  }
  return CodeInThisFileDialog;
}

/** The three views of Script Permissions, one at a time: the policy table
 *  alone is some 250 rows, which would bury the activity log under it. */
const PERMISSION_TABS = [
  { id: "mounted", label: "Running scripts" },
  { id: "policy", label: "What scripts can do" },
  { id: "activity", label: "Activity" },
] as const;

type PermissionTab = (typeof PERMISSION_TABS)[number]["id"];

/** Which tab a caller asked for (`showDialog(id, { tab })`), else the first. */
function requestedTab(data: Record<string, unknown> | undefined): PermissionTab {
  const tab = data?.tab;
  return PERMISSION_TABS.some((t) => t.id === tab) ? (tab as PermissionTab) : "mounted";
}

/** Script Permissions: running scripts, the policy table, the activity log. */
export function createScriptPermissionsDialog(icons: TransparencyDialogIcons): React.ComponentType<DialogProps> {
  function ScriptPermissionsDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
    const [tab, setTab] = useState<PermissionTab>(() => requestedTab(data));
    // A second showDialog while open (e.g. "N refused" -> Activity) switches tab.
    useEffect(() => {
      setTab(requestedTab(data));
    }, [data]);
    if (!isOpen) return null;
    return (
      <TransparencyDialogFrame
        title="Script Permissions"
        icon={icons.permissions}
        width={720}
        height={640}
        testId="script-permissions-dialog"
        onClose={onClose}
        toolbar={
          <SegmentedTabs
            tabs={PERMISSION_TABS}
            value={tab}
            onChange={(id) => setTab(id as PermissionTab)}
            ariaLabel="Script Permissions"
            testIdPrefix="script-permissions-tab-"
          />
        }
      >
        {tab === "mounted" && <MountedScriptsSection placement="sidebar" />}
        {tab === "policy" && <PolicyTableSection placement="sidebar" />}
        {tab === "activity" && <ActivitySection placement="sidebar" />}
      </TransparencyDialogFrame>
    );
  }
  return ScriptPermissionsDialog;
}
