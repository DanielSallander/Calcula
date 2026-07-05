//! FILENAME: app/extensions/CellTypes/types/button.ts
// PURPOSE: The "calcula.button" cell type — a cell that renders as a button
//          and fires an action on click: a registered command or a workbook
//          script. The cell's value is the label (params.label as fallback).
// PARAMS:  label (string), action: { kind: "command", commandId } |
//          { kind: "script", scriptId, functionName? }.
// SECURITY: script actions run through runWorkbookScript (global script
//          security gate); failures surface as toasts — a click that silently
//          does nothing is a transparency failure.

import type { CellTypeDefinition, CellTypeRenderContext } from "@api/cellTypes";

export const BUTTON_TYPE_ID = "calcula.button";

export interface ButtonAction {
  kind: "command" | "script";
  commandId?: string;
  scriptId?: string;
  functionName?: string;
}

function renderButton(context: CellTypeRenderContext): boolean {
  const { ctx, cellLeft, cellTop, cellRight, cellBottom, value, params, styleIndex, styleCache } =
    context;

  const cellWidth = cellRight - cellLeft;
  const cellHeight = cellBottom - cellTop;
  if (cellWidth < 12 || cellHeight < 10) {
    return true;
  }

  const inset = 2;
  const btnLeft = cellLeft + inset;
  const btnTop = cellTop + inset;
  const btnWidth = cellWidth - inset * 2;
  const btnHeight = cellHeight - inset * 2;
  const radius = Math.min(4, btnHeight / 3);

  // Face + border
  ctx.beginPath();
  ctx.roundRect(btnLeft + 0.5, btnTop + 0.5, btnWidth - 1, btnHeight - 1, radius);
  ctx.fillStyle = "#f5f5f5";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#b5b5b5";
  ctx.stroke();

  // Subtle bottom shading for a raised look
  ctx.beginPath();
  ctx.moveTo(btnLeft + radius, btnTop + btnHeight - 1);
  ctx.lineTo(btnLeft + btnWidth - radius, btnTop + btnHeight - 1);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.12)";
  ctx.stroke();

  // Label (value wins; params.label is the fallback for empty cells)
  const label =
    value !== "" ? value : typeof params.label === "string" && params.label ? params.label : "Button";
  const style = styleCache.get(styleIndex) ?? styleCache.get(0);
  const fontSize = Math.min(style?.fontSize || 11, btnHeight - 4);
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${style?.bold ? "bold" : "normal"} ${fontSize}px ${fontFamily}`;
  ctx.fillStyle = style?.textColor || "#303030";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maxTextWidth = btnWidth - 8;
  let text = label;
  if (ctx.measureText(text).width > maxTextWidth) {
    while (text.length > 1 && ctx.measureText(text + "…").width > maxTextWidth) {
      text = text.slice(0, -1);
    }
    text += "…";
  }
  ctx.fillText(text, btnLeft + btnWidth / 2, btnTop + btnHeight / 2 + 0.5);
  return true;
}

/** Run the button's configured action (command or workbook script). */
async function runButtonAction(action: ButtonAction): Promise<void> {
  const { showToast } = await import("../../../src/api/notifications");

  if (action.kind === "command" && action.commandId) {
    const { ExtensionRegistry } = await import("../../../src/api");
    const command = ExtensionRegistry.getCommand(action.commandId);
    if (!command) {
      showToast(`Button command "${action.commandId}" is not registered`, { variant: "error" });
      return;
    }
    try {
      const { getGridStateSnapshot } = await import("../../../src/api/grid");
      const { getCell, updateCell } = await import("../../../src/api/lib");
      await command.execute({
        selection: getGridStateSnapshot()?.selection ?? null,
        getCellValue: async (row, col) => (await getCell(row, col))?.display ?? null,
        setCellValue: async (row, col, value) => {
          await updateCell(row, col, value);
        },
        refreshGrid: () => window.dispatchEvent(new CustomEvent("grid:refresh")),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Button command failed: ${msg}`, { variant: "error" });
    }
    return;
  }

  if (action.kind === "script" && action.scriptId) {
    try {
      const { getWorkbookScript, runWorkbookScript } = await import(
        "../../../src/api/workbookScripts"
      );
      const script = await getWorkbookScript(action.scriptId);
      if (!script || !script.source) {
        showToast("Button script not found in this workbook", { variant: "error" });
        return;
      }
      const source = action.functionName
        ? `${script.source}\n${action.functionName}();`
        : script.source;
      const result = await runWorkbookScript(source, `button_${script.name || "script"}.js`);
      if (result.type === "success" && result.cellsModified > 0 && result.screenUpdating !== false) {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } else if (result.type === "error") {
        console.error(`[CellTypes] Button script error: ${result.message}`);
        showToast(`Button script couldn't run: ${result.message}`, { variant: "error" });
      }
    } catch (err) {
      console.error("[CellTypes] Failed to execute button action:", err);
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Button script couldn't run: ${msg}`, { variant: "error" });
    }
    return;
  }

  showToast("This button has no action configured (right-click ▸ Cell Type)", {
    variant: "info",
  });
}

export const buttonCellType: CellTypeDefinition = {
  id: BUTTON_TYPE_ID,
  render: renderButton,
  editor: "none",
  onClick: async ({ row, col, params }) => {
    const { getDesignMode } = await import("../../../src/api/designMode");
    if (getDesignMode()) {
      return false; // Design mode: click selects/edits, run mode fires.
    }
    // Select the cell so keyboard focus follows the click, then fire.
    const { dispatchGridAction } = await import("../../../src/api/gridDispatch");
    const { setSelection } = await import("../../../src/api/grid");
    dispatchGridAction(
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" })
    );
    await runButtonAction((params.action ?? {}) as ButtonAction);
    return true;
  },
  getCursor: () => "pointer",
  displayText: (value, params) =>
    value !== "" ? value : typeof params.label === "string" ? params.label : "",
};
