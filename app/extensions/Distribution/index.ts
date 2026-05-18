// FILENAME: app/extensions/Distribution/index.ts
// PURPOSE: Distribution extension entry point — .calp publish, subscribe, refresh, overrides.
// CONTEXT: Registers task pane, dialogs, menu items, and grid overlay badges.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { OverridesPane } from "./components/OverridesPane";
import {
  DistributionManifest,
  OVERRIDES_PANE_ID,
  PUBLISH_DIALOG_ID,
  SUBSCRIBE_DIALOG_ID,
  REFRESH_PREVIEW_DIALOG_ID,
  PublishDialogDefinition,
  SubscribeDialogDefinition,
  RefreshPreviewDialogDefinition,
} from "./manifest";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  if (isActivated) return;

  // Register the Overrides task pane
  context.ui.taskPanes.register({
    id: OVERRIDES_PANE_ID,
    title: "Overrides",
    component: OverridesPane,
    contextKeys: ["always"],
    priority: 35,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(OVERRIDES_PANE_ID));

  // Register dialogs
  context.ui.dialogs.register(PublishDialogDefinition);
  context.ui.dialogs.register(SubscribeDialogDefinition);
  context.ui.dialogs.register(RefreshPreviewDialogDefinition);
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(SUBSCRIBE_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(REFRESH_PREVIEW_DIALOG_ID));

  // Register menu items under Data menu
  context.ui.menus.registerItem("data", {
    id: "data:publishPackage",
    label: "Publish Package...",
    action: () => context.ui.dialogs.open(PUBLISH_DIALOG_ID),
    order: 900,
  });

  context.ui.menus.registerItem("data", {
    id: "data:subscribePackage",
    label: "Subscribe to Package...",
    action: () => context.ui.dialogs.open(SUBSCRIBE_DIALOG_ID),
    order: 901,
  });

  context.ui.menus.registerItem("data", {
    id: "data:refreshSubscriptions",
    label: "Refresh Subscriptions...",
    action: () => context.ui.dialogs.open(REFRESH_PREVIEW_DIALOG_ID),
    order: 902,
  });

  context.ui.menus.registerItem("data", {
    id: "data:showOverrides",
    label: "Show Overrides Pane",
    action: () => {
      context.ui.taskPanes.open(OVERRIDES_PANE_ID);
      context.ui.taskPanes.showContainer();
    },
    order: 903,
  });

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;
  for (const fn of cleanupFns) {
    try { fn(); } catch {}
  }
  cleanupFns.length = 0;
  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: DistributionManifest,
  activate,
  deactivate,
};

export default extension;
