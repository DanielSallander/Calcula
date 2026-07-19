// FILENAME: app/extensions/Distribution/manifest.ts
// PURPOSE: Distribution extension manifest and UI definitions.

import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
import React from "react";
import { PublishDialog } from "./components/PublishDialog";
import { PublishModelDialog } from "./components/PublishModelDialog";
import { SubscribeDialog } from "./components/SubscribeDialog";
import { RefreshPreviewDialog } from "./components/RefreshPreviewDialog";
import { DesignateWritebackDialog } from "./components/DesignateWritebackDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";

export const DISTRIBUTION_EXTENSION_ID = "calcula.distribution";
export const OVERRIDES_PANE_ID = "distribution:overrides";
export const WRITEBACK_PANE_ID = "distribution:writeback";
export const SUBSCRIPTIONS_PANE_ID = "distribution:subscriptions";
export const PUBLISHER_DASHBOARD_PANE_ID = "distribution:publisherDashboard";
export const AUDIT_LOG_PANE_ID = "distribution:auditLog";
export const PACKAGE_EXPLORER_PANEL_ID = "distribution:packageExplorer";

export const DistributionManifest: AddInManifest = {
  id: DISTRIBUTION_EXTENSION_ID,
  name: "Distribution",
  version: "1.0.0",
  description: "Publish and subscribe to .calp packages",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Dialogs
// ============================================================================

export const PUBLISH_DIALOG_ID = "distribution:publishDialog";
export const PUBLISH_MODEL_DIALOG_ID = "distribution:publishModelDialog";
export const SUBSCRIBE_DIALOG_ID = "distribution:subscribeDialog";
export const REFRESH_PREVIEW_DIALOG_ID = "distribution:refreshPreviewDialog";
export const DESIGNATE_WRITEBACK_DIALOG_ID = "distribution:designateWritebackDialog";
export const CONNECTION_DIALOG_ID = "distribution:connectionDialog";

export const PublishDialogDefinition: DialogDefinition = {
  id: PUBLISH_DIALOG_ID,
  component: PublishDialog as React.ComponentType<DialogProps>,
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
};

export const RefreshPreviewDialogDefinition: DialogDefinition = {
  id: REFRESH_PREVIEW_DIALOG_ID,
  component: RefreshPreviewDialog as React.ComponentType<DialogProps>,
  priority: 100,
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
