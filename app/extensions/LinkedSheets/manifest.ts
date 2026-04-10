// FILENAME: app/extensions/LinkedSheets/manifest.ts
// PURPOSE: Extension manifest and dialog definitions for Linked Sheets.

import type { DialogDefinition } from "@api/uiTypes";
import { PublishDialog } from "./components/PublishDialog";
import { BrowseLinkedDialog } from "./components/BrowseLinkedDialog";

export const LinkedSheetsManifest = {
  id: "calcula.linked-sheets",
  name: "Linked Sheets",
  version: "1.0.0",
  description:
    "Publish sheets to shared locations and link them into consumer workbooks with refresh.",
};

export const PUBLISH_DIALOG_ID = "linked-sheets-publish";
export const BROWSE_LINKED_DIALOG_ID = "linked-sheets-browse";

export const PublishDialogDefinition: DialogDefinition = {
  id: PUBLISH_DIALOG_ID,
  component: PublishDialog,
};

export const BrowseLinkedDialogDefinition: DialogDefinition = {
  id: BROWSE_LINKED_DIALOG_ID,
  component: BrowseLinkedDialog,
};
