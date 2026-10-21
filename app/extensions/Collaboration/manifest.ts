// FILENAME: app/extensions/Collaboration/manifest.ts
// PURPOSE: Collaboration extension manifest and UI definitions.

import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
import type { PanelDefinition } from "@api/uiTypes";
import { RibbonIcon } from "@api/ribbonIcons";
import { ICON_SIZE_SM } from "@api/layout";
import React from "react";
import { PublishDialog } from "./components/PublishDialog";
import { CheckoutDialog } from "./components/CheckoutDialog";
import { PublishModelDialog } from "./components/PublishModelDialog";
import { SubscribeDialog } from "./components/SubscribeDialog";
import { RefreshPreviewDialog } from "./components/RefreshPreviewDialog";
import { SubscriptionDiffDialog } from "./components/SubscriptionDiffDialog";
import { DesignateWritebackDialog } from "./components/DesignateWritebackDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { PromoteDialog } from "./components/PromoteDialog";
import { EditPipelineDialog } from "./components/EditPipelineDialog";
import { WRITEBACK_TAB_SECTIONS } from "./components/WritebackTabSections";
import { WRITEBACK_PUBLISHER_TAB_SECTIONS } from "./components/WritebackPublisherTabSections";
import {
  WRITEBACK_PANE_ID,
  WRITEBACK_TAB_ID,
  PUBLISHER_DASHBOARD_PANE_ID,
  DESIGNATE_WRITEBACK_DIALOG_ID,
} from "./lib/writebackIds";

export const COLLABORATION_EXTENSION_ID = "calcula.collaboration";

// Two top-level menus, because these are two features and not one. .calp
// application distribution (publish / subscribe / refresh / overrides) and
// writeback (the two-way data-collection channel back to the publisher) used
// to share a single "Distribution" submenu under External Data (the feature was
// renamed Collaboration on 2026-09-25); they are peers
// of Data and Model, not accessories of an import menu.
export const COLLABORATION_MENU_ID = "collaboration";
export const WRITEBACK_MENU_ID = "writeback";

export const OVERRIDES_PANE_ID = "collaboration:overrides";
// Defined in lib/writebackIds.ts (a module that imports nothing), so the
// contextual tab's actions can name the pane without importing this file.
export { WRITEBACK_PANE_ID, WRITEBACK_TAB_ID, PUBLISHER_DASHBOARD_PANE_ID, DESIGNATE_WRITEBACK_DIALOG_ID };
export const SUBSCRIPTIONS_PANE_ID = "collaboration:subscriptions";
export const AUDIT_LOG_PANE_ID = "collaboration:auditLog";
export const APPLICATION_EXPLORER_PANEL_ID = "collaboration:applicationExplorer";

export const CollaborationManifest: AddInManifest = {
  id: COLLABORATION_EXTENSION_ID,
  name: "Collaboration",
  version: "1.0.0",
  description: "Publish and subscribe to .calp applications",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Dialogs
// ============================================================================

export const PUBLISH_DIALOG_ID = "collaboration:publishDialog";
export const CHECKOUT_DIALOG_ID = "collaboration:checkoutDialog";
export const PUBLISH_MODEL_DIALOG_ID = "collaboration:publishModelDialog";
export const SUBSCRIBE_DIALOG_ID = "collaboration:subscribeDialog";
export const REFRESH_PREVIEW_DIALOG_ID = "collaboration:refreshPreviewDialog";
/** One id for BOTH subscriber-diff entries; `data.mode` picks the footer. */
export const SUBSCRIPTION_DIFF_DIALOG_ID = "collaboration:subscriptionDiffDialog";
export const CONNECTION_DIALOG_ID = "collaboration:connectionDialog";
/** One id for BOTH directions; `data.mode` picks promote or rollback. */
export const PROMOTE_DIALOG_ID = "collaboration:promoteDialog";
export const EDIT_PIPELINE_DIALOG_ID = "collaboration:editPipelineDialog";

export const PublishDialogDefinition: DialogDefinition = {
  id: PUBLISH_DIALOG_ID,
  component: PublishDialog as React.ComponentType<DialogProps>,
  priority: 100,
  // Non-modal floating window: the workbook stays interactive while it is
  // open, so a grid-level Escape must not dismiss it.
  dismissOnEscape: false,
};

export const CheckoutDialogDefinition: DialogDefinition = {
  id: CHECKOUT_DIALOG_ID,
  component: CheckoutDialog as React.ComponentType<DialogProps>,
  priority: 100,
  // Non-modal floating window: the workbook stays interactive while it is
  // open, so a grid-level Escape must not dismiss it.
  dismissOnEscape: false,
};

export const PublishModelDialogDefinition: DialogDefinition = {
  id: PUBLISH_MODEL_DIALOG_ID,
  component: PublishModelDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const SubscribeDialogDefinition: DialogDefinition = {
  id: SUBSCRIBE_DIALOG_ID,
  component: SubscribeDialog as React.ComponentType<DialogProps>,
  priority: 100,
  // Non-modal floating window: the workbook stays interactive while it is
  // open, so a grid-level Escape must not dismiss it.
  dismissOnEscape: false,
};

export const RefreshPreviewDialogDefinition: DialogDefinition = {
  id: REFRESH_PREVIEW_DIALOG_ID,
  component: RefreshPreviewDialog as React.ComponentType<DialogProps>,
  priority: 100,
  // Non-modal floating window: the workbook stays interactive while it is
  // open, so a grid-level Escape must not dismiss it.
  dismissOnEscape: false,
};

export const SubscriptionDiffDialogDefinition: DialogDefinition = {
  id: SUBSCRIPTION_DIFF_DIALOG_ID,
  component: SubscriptionDiffDialog as React.ComponentType<DialogProps>,
  priority: 100,
  // Non-modal floating window: the workbook stays interactive while it is
  // open, so a grid-level Escape must not dismiss it. That matters more here
  // than elsewhere — the whole point is to look at the sheets while deciding.
  dismissOnEscape: false,
};

export const DesignateWritebackDialogDefinition: DialogDefinition = {
  id: DESIGNATE_WRITEBACK_DIALOG_ID,
  component: DesignateWritebackDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const ConnectionDialogDefinition: DialogDefinition = {
  id: CONNECTION_DIALOG_ID,
  component: ConnectionDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const PromoteDialogDefinition: DialogDefinition = {
  id: PROMOTE_DIALOG_ID,
  component: PromoteDialog as React.ComponentType<DialogProps>,
  priority: 100,
  // Non-modal floating window: the workbook stays interactive while it is
  // open. That matters here — the whole point is to look at what changes
  // before moving what an audience receives.
  dismissOnEscape: false,
};

export const EditPipelineDialogDefinition: DialogDefinition = {
  id: EDIT_PIPELINE_DIALOG_ID,
  component: EditPipelineDialog as React.ComponentType<DialogProps>,
  priority: 100,
  dismissOnEscape: false,
};

// ============================================================================
// The contextual "Writeback" ribbon tab
// ============================================================================

/** Right of every other contextual tab (Report/Sparkline 510), Excel's place. */
export const WRITEBACK_TAB_ORDER = 512;

/** The tab's accent: the skin's writeback token, its light value as fallback. */
export const WRITEBACK_TAB_COLOR = "var(--tab-accent-writeback, #4338ca)";

/**
 * Shown while Core's ACTIVE cell is inside a subscribed writeback region on the
 * active sheet (lib/writebackTab.ts). The label is "Writeback" like the
 * top-level menu; the ids differ (`writeback-tab` vs `writeback`). It never
 * takes the selection when it appears: a contextual tab that steals the ribbon
 * on every arrow key into a form would be worse than none.
 */
export const WritebackPanelDefinition: PanelDefinition = {
  id: WRITEBACK_TAB_ID,
  title: "Writeback",
  icon: React.createElement(RibbonIcon.Upload, { size: ICON_SIZE_SM }),
  sections: WRITEBACK_TAB_SECTIONS,
  defaultPlacement: "ribbon",
  ribbonOrder: WRITEBACK_TAB_ORDER,
  ribbonColor: WRITEBACK_TAB_COLOR,
  priority: 1000 - WRITEBACK_TAB_ORDER,
};

/**
 * The SAME tab -- same id, label, colour and place -- as the PUBLISHER sees it:
 * shown while Core's active cell is inside a writeback region THIS workbook
 * designated (a fresh workbook or a working copy), with Edit Region, Remove
 * Region and Collected Responses instead of the subscriber's Submit and drafts.
 * lib/writebackTab.ts registers whichever of the two fits the region under the
 * cursor; they are never registered together.
 */
export const WritebackPublisherPanelDefinition: PanelDefinition = {
  ...WritebackPanelDefinition,
  sections: WRITEBACK_PUBLISHER_TAB_SECTIONS,
};
