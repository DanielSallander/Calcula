// FILENAME: app/extensions/Collaboration/manifest.ts
// PURPOSE: Collaboration extension manifest and UI definitions.

import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
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
export const WRITEBACK_PANE_ID = "collaboration:writeback";
export const SUBSCRIPTIONS_PANE_ID = "collaboration:subscriptions";
export const PUBLISHER_DASHBOARD_PANE_ID = "collaboration:publisherDashboard";
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
export const DESIGNATE_WRITEBACK_DIALOG_ID = "collaboration:designateWritebackDialog";
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
