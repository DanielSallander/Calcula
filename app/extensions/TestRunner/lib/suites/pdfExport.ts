//! FILENAME: app/extensions/TestRunner/lib/suites/pdfExport.ts
// PURPOSE: Test suite for PDF export functionality.
// CONTEXT: Tests that generatePdf produces valid PDF output from PrintData.
//          Cannot test actual file saving (requires user dialog), but validates
//          the core generation pipeline end-to-end.

import type { TestSuite } from "../types";
import { assertTrue, expectNotNull } from "../assertions";
import { AREA_PDF_EXPORT } from "../testArea";
import { getPrintData } from "@api/backend";
import { generatePdf } from "../../../Print/lib/pdfGenerator";

const A = AREA_PDF_EXPORT;

export const pdfExportSuite: TestSuite = {
  name: "PDF Export",
  description: "Tests PDF generation from print data.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Generate PDF from basic data",
      description: "generatePdf returns a non-empty ArrayBuffer.",
      run: async (ctx) => {
        // Add some content
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Report Title" },
          { row: A.row + 1, col: A.col, value: "100" },
          { row: A.row + 1, col: A.col + 1, value: "200" },
          { row: A.row + 2, col: A.col, value: "300" },
          { row: A.row + 2, col: A.col + 1, value: "400" },
        ]);
        await ctx.settle();

        const printData = await getPrintData();
        expectNotNull(printData, "print data should exist");

        const pdfBuffer = generatePdf(printData);
        assertTrue(pdfBuffer instanceof ArrayBuffer, "result should be ArrayBuffer");
        assertTrue(pdfBuffer.byteLength > 0, "PDF should not be empty");
        ctx.log(`PDF size: ${pdfBuffer.byteLength} bytes`);

        // Validate PDF header magic bytes (%PDF)
        const header = new Uint8Array(pdfBuffer.slice(0, 5));
        const magic = String.fromCharCode(...header);
        assertTrue(magic.startsWith("%PDF"), `Expected PDF header, got "${magic}"`);
      },
    },
    {
      name: "PDF from empty sheet",
      description: "generatePdf handles an empty sheet without errors.",
      run: async (ctx) => {
        // Don't add any data — test with whatever is on the sheet (cleared by afterEach)
        const printData = await getPrintData();
        expectNotNull(printData, "print data should exist");

        const pdfBuffer = generatePdf(printData);
        assertTrue(pdfBuffer instanceof ArrayBuffer, "result should be ArrayBuffer");
        assertTrue(pdfBuffer.byteLength > 0, "PDF should not be empty even for blank sheet");

        const header = new Uint8Array(pdfBuffer.slice(0, 5));
        const magic = String.fromCharCode(...header);
        assertTrue(magic.startsWith("%PDF"), `Expected PDF header, got "${magic}"`);
      },
    },
    {
      name: "PDF from data with formulas",
      description: "Formulas are evaluated before PDF generation — display values appear.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: `=SUM(${A.ref(0, 0)}:${A.ref(1, 0)})` },
        ]);
        await ctx.settle();

        const printData = await getPrintData();
        expectNotNull(printData, "print data should exist");

        // Verify the formula cell has a display value in print data
        const formulaCell = printData.cells.find(
          (c) => c.row === A.row + 2 && c.col === A.col
        );
        if (formulaCell) {
          assertTrue(
            formulaCell.display === "30",
            `Expected formula display "30", got "${formulaCell.display}"`
          );
        }

        const pdfBuffer = generatePdf(printData);
        assertTrue(pdfBuffer.byteLength > 0, "PDF with formulas should not be empty");
        ctx.log(`PDF with formulas: ${pdfBuffer.byteLength} bytes`);
      },
    },
    {
      name: "PDF with multiple columns and rows",
      description: "Larger dataset produces bigger PDF.",
      run: async (ctx) => {
        // Create a 5x4 data block
        const updates = [];
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 4; c++) {
            updates.push({
              row: A.row + r,
              col: A.col + c,
              value: `R${r + 1}C${c + 1}`,
            });
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        const printData = await getPrintData();
        const pdfBuffer = generatePdf(printData);
        assertTrue(pdfBuffer.byteLength > 100, "Larger dataset should produce substantial PDF");
        ctx.log(`5x4 grid PDF: ${pdfBuffer.byteLength} bytes`);
      },
    },
    {
      name: "PDF with numeric formatting",
      description: "Cells with numbers produce valid PDF.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1234.56" },
          { row: A.row, col: A.col + 1, value: "-99.99" },
          { row: A.row, col: A.col + 2, value: "0" },
          { row: A.row + 1, col: A.col, value: "=PI()" },
        ]);
        await ctx.settle();

        const printData = await getPrintData();
        const pdfBuffer = generatePdf(printData);
        assertTrue(pdfBuffer instanceof ArrayBuffer, "should be ArrayBuffer");
        assertTrue(pdfBuffer.byteLength > 0, "should not be empty");

        const header = new Uint8Array(pdfBuffer.slice(0, 5));
        const magic = String.fromCharCode(...header);
        assertTrue(magic.startsWith("%PDF"), "valid PDF header");
      },
    },
    {
      name: "PrintData structure is complete",
      description: "getPrintData returns all required fields.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Test" },
        ]);
        await ctx.settle();

        const pd = await getPrintData();
        expectNotNull(pd, "print data");
        assertTrue(Array.isArray(pd.cells), "cells should be array");
        assertTrue(Array.isArray(pd.styles), "styles should be array");
        assertTrue(typeof pd.colWidths === "object", "colWidths should exist");
        assertTrue(typeof pd.rowHeights === "object", "rowHeights should exist");
        assertTrue(Array.isArray(pd.mergedRegions), "mergedRegions should be array");
        assertTrue(typeof pd.pageSetup === "object", "pageSetup should exist");
        assertTrue(typeof pd.sheetName === "string", "sheetName should be string");
        assertTrue(Array.isArray(pd.bounds), "bounds should be array");
        assertTrue(pd.bounds.length === 2, "bounds should have [maxRow, maxCol]");
        ctx.log(`Fields: cells=${pd.cells.length}, styles=${pd.styles.length}, bounds=[${pd.bounds}]`);
      },
    },
  ],
};
