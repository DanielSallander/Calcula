import { describe, it } from "vitest";
import * as fs from "node:fs";
import { buildSurfacePrompt, fullSurfaceCost } from "../index";

describe("ztemp measure", () => {
  it("writes real cost at the chat budget", () => {
    const lines: string[] = [];
    for (const t of ["button", "sheet", "shape", "chart", "workbook"]) {
      const r = buildSurfacePrompt({ objectType: t, budgetTokens: 6000 });
      const full = buildSurfacePrompt({ objectType: t, budgetTokens: 1_000_000 });
      lines.push(
        `${t}: cost=${r.costTokens} chars=${r.text.length} included=${r.includedChains.length} omitted=${r.omittedCount} truncated=${r.truncated} | fullCost=${full.costTokens} fullChains=${full.includedChains.length} rankSum=${fullSurfaceCost(t)}`,
      );
    }
    fs.writeFileSync("C:/Users/Salle/AppData/Local/Temp/claude/surface-measure.txt", lines.join("\n"));
  });
});
