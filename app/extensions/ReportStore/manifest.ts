//! FILENAME: app/extensions/ReportStore/manifest.ts
// PURPOSE: Extension manifest and dialog definitions for the Report Store.

import type { DialogDefinition } from "@api/uiTypes";
import { BrowseDialog } from "./components/BrowseDialog";
import { ExportDialog } from "./components/ExportDialog";
import { BindingDialog } from "./components/BindingDialog";

export const ReportStoreManifest = {
  id: "calcula.report-store",
  name: "Report Store",
  version: "0.1.0",
  description: "Browse, import, and export distributable report packages (.calp)",
};

export const BROWSE_DIALOG_ID = "report-store-browse";
export const EXPORT_DIALOG_ID = "report-store-export";
export const BINDING_DIALOG_ID = "report-store-binding";

export const BrowseDialogDefinition: DialogDefinition = {
  id: BROWSE_DIALOG_ID,
  component: BrowseDialog,
};

export const ExportDialogDefinition: DialogDefinition = {
  id: EXPORT_DIALOG_ID,
  component: ExportDialog,
};

export const BindingDialogDefinition: DialogDefinition = {
  id: BINDING_DIALOG_ID,
  component: BindingDialog,
};
