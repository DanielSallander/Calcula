//! FILENAME: app/src/api/printService.ts
// PURPOSE: The feature-neutral seam through which the API facade can ask "render
//          this workbook as a printable document" without knowing that a Print
//          extension exists.
// CONTEXT: Inversion of Control, the same shape componentStoreRegistry uses for
//          charts/slicers/pivots. The Print extension OWNS page setup, page
//          breaks, headers/footers and the PDF writer; @api owns nothing about
//          printing except this one contract. The script broker's
//          `cap.filePrintPdf` executor is the first consumer — without this seam
//          it would have to import an extension, which the API-neutrality rule
//          (No First-Class Citizens) forbids outright.
//
// WHY ONLY PDF, AND NOT "PRINT". The Print extension's other exit is
// `executePrint()`, which opens a popup window, writes HTML into it and calls
// `window.print()` after a 500 ms timer. That is not a headless operation: it
// needs a window, it needs the pop-up to be allowed, and it hands control to the
// OS print dialog with no result to report back. There is no honest way to offer
// it to a script — a call that may silently do nothing (blocked pop-up) and can
// never report success is exactly the kind of API that "answers wrong". The PDF
// path, by contrast, is pure: page data in, bytes out. So that is the whole
// contract, and the gap is documented rather than faked.

/**
 * Renders the CURRENTLY PRINTABLE view of the workbook to PDF bytes.
 *
 * "Currently printable" is the provider's business, not the caller's: today the
 * Print extension resolves the active sheet's page setup, print area, print
 * titles, page breaks and headers/footers, exactly as File ▸ Export to PDF does.
 * The provider takes NO arguments on purpose — a caller that could name a range
 * or a sheet would be a second, competing page-setup model.
 */
export type PdfRenderer = () => Promise<Uint8Array>;

let pdfRenderer: PdfRenderer | null = null;

/**
 * Register the workbook-to-PDF renderer. Called once by the Print extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the renderer if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerPdfRenderer(renderer: PdfRenderer): () => void {
  pdfRenderer = renderer;
  return () => {
    if (pdfRenderer === renderer) pdfRenderer = null;
  };
}

/** Whether any extension can currently render a PDF. */
export function hasPdfRenderer(): boolean {
  return pdfRenderer !== null;
}

/**
 * Render the workbook to PDF bytes.
 *
 * THROWS when no provider is registered (the Print extension is disabled or
 * failed to load). Refusing loudly is the point: a script that asked for a PDF
 * and silently received nothing has been lied to, and a caller cannot tell "no
 * printer" from "empty document" if the answer is an empty buffer.
 */
export async function renderWorkbookPdf(): Promise<Uint8Array> {
  if (!pdfRenderer) {
    throw new Error(
      "PDF export is unavailable: no print provider is registered (the Print extension is not loaded).",
    );
  }
  const bytes = await pdfRenderer();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("PDF export produced no data.");
  }
  return bytes;
}

/** Test/reset hook: forget the registered renderer. */
export function resetPdfRenderer(): void {
  pdfRenderer = null;
}
