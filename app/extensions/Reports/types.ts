//! FILENAME: app/extensions/Reports/types.ts
// PURPOSE: Frontend shapes for grid reports. `ReportInfo` mirrors the Rust
//   SavedReport returned by list_reports (camelCase over IPC).

export interface ReportInfo {
  id: string;
  name: string;
  dslText: string;
  connectionId: string;
  sheetIndex: number;
  anchorRow: number;
  anchorCol: number;
  endRow: number;
  endCol: number;
}
