import { describe, it, expect } from "vitest";
import { generateMacroSource, type RecordedAction } from "../actionCodegen";

describe("generateMacroSource", () => {
  it("emits a setCellValue call per action carrying the sheet index", () => {
    const actions: RecordedAction[] = [
      { row: 0, col: 0, value: "5", sheetIndex: 0 },
      { row: 0, col: 1, value: "=A1*2", sheetIndex: 0 },
      { row: 3, col: 2, value: "hello", sheetIndex: 2 },
    ];
    const src = generateMacroSource(actions);
    expect(src).toContain('Calcula.setCellValue(0, 0, "5", 0);');
    expect(src).toContain('Calcula.setCellValue(0, 1, "=A1*2", 0);');
    expect(src).toContain('Calcula.setCellValue(3, 2, "hello", 2);');
    // One call per action, in order.
    const calls = src.split("\n").filter((l) => l.startsWith("Calcula.setCellValue("));
    expect(calls).toHaveLength(3);
  });

  it("safely escapes quotes, backslashes, and newlines in values", () => {
    const value = 'a"b\\c\nd';
    const src = generateMacroSource([{ row: 2, col: 3, value, sheetIndex: 1 }]);
    // The codegen JSON-encodes the value; assert against the same encoding.
    expect(src).toContain(`Calcula.setCellValue(2, 3, ${JSON.stringify(value)}, 1);`);
  });

  it("handles an empty recording without emitting calls", () => {
    const src = generateMacroSource([]);
    expect(src).toContain("no actions were recorded");
    expect(src).not.toContain("Calcula.setCellValue(");
  });
});
