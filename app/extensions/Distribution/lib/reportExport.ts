// FILENAME: app/extensions/Distribution/lib/reportExport.ts
// PURPOSE: Save / print the self-contained HTML report rendered from a .calp
//          package version (recipient reach: A = save .html, B = print -> Save
//          as PDF, C = save the multi-sheet viewer .html). All three flow from
//          one rendered HTML string; the mode is chosen when rendering.

import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "@api/lib";

/**
 * Save a rendered HTML report to a user-chosen `.html` file (A / C). Returns the
 * path written, or null if the user cancelled the save dialog.
 */
export async function saveHtmlReport(
  html: string,
  suggestedName: string,
): Promise<string | null> {
  const filePath = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Web Page", extensions: ["html"] }],
  });
  if (!filePath) return null;
  // writeBinaryFile (the only text/binary write exposed via @api) takes a byte
  // array; encode the HTML as UTF-8.
  await writeBinaryFile(filePath, Array.from(new TextEncoder().encode(html)));
  return filePath;
}

/**
 * Save collected-submission CSV text to a user-chosen `.csv` file. Returns the
 * path written, or null if the user cancelled the save dialog.
 */
export async function saveCsvReport(
  csv: string,
  suggestedName: string,
): Promise<string | null> {
  const filePath = await save({
    defaultPath: suggestedName,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!filePath) return null;
  await writeBinaryFile(filePath, Array.from(new TextEncoder().encode(csv)));
  return filePath;
}

/**
 * Save collected-submission Parquet bytes to a user-chosen `.parquet` file.
 * Returns the path written, or null if the user cancelled the save dialog.
 */
export async function saveParquetReport(
  bytes: number[],
  suggestedName: string,
): Promise<string | null> {
  const filePath = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Parquet", extensions: ["parquet"] }],
  });
  if (!filePath) return null;
  await writeBinaryFile(filePath, bytes);
  return filePath;
}

/**
 * Save an override patch (C2c) as a user-chosen `.json` file, so a subscriber
 * can share their override layer with another subscriber of the same package.
 * Returns the path written, or null if the user cancelled.
 */
export async function saveJsonPatch(
  json: string,
  suggestedName: string,
): Promise<string | null> {
  const filePath = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Override Patch", extensions: ["json"] }],
  });
  if (!filePath) return null;
  await writeBinaryFile(filePath, Array.from(new TextEncoder().encode(json)));
  return filePath;
}

/**
 * Open a rendered (print-ready) HTML report in a new window and trigger the
 * browser print dialog — from which the recipient picks "Save as PDF" (B).
 * Mirrors the Print extension's window.open + print pattern (no new deps).
 */
export function printHtmlReport(html: string): void {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    throw new Error("Could not open a print window (popup blocked?).");
  }
  w.document.write(html);
  w.document.close();
  // Let layout settle before invoking print so the first page isn't blank.
  setTimeout(() => {
    try {
      w.print();
    } catch {
      /* user closed the window before print resolved */
    }
  }, 300);
}
