//! FILENAME: app/extensions/FlashFill/lib/__tests__/patternEngine-learning.test.ts
// PURPOSE: Deep tests for learning behavior, program quality, and edge cases.

import { describe, it, expect } from "vitest";
import { learn, applyProgram } from "../patternEngine";
import type { Example, Program } from "../patternEngine";

// ============================================================================
// Learning from increasing numbers of examples
// ============================================================================

describe("learning with increasing example counts", () => {
  const allExamples: Example[] = [
    { sources: ["John Smith"], output: "Smith" },
    { sources: ["Jane Doe"], output: "Doe" },
    { sources: ["Alexandra Jones"], output: "Jones" },
    { sources: ["Bo Li"], output: "Li" },
    { sources: ["Mary-Jane Watson"], output: "Watson" },
  ];

  it("learns from 1 example", () => {
    const program = learn(allExamples.slice(0, 1));
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["John Smith"])).toBe("Smith");
  });

  it("learns from 2 examples and generalizes to variable-length first names", () => {
    const program = learn(allExamples.slice(0, 2));
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["Alexandra Jones"])).toBe("Jones");
  });

  it("learns from 3 examples consistently", () => {
    const program = learn(allExamples.slice(0, 3));
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["Bo Li"])).toBe("Li");
  });

  it("learns from 5 examples and handles short names", () => {
    const program = learn(allExamples.slice(0, 5));
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["Al Z"])).toBe("Z");
  });

  it("adding more valid examples does not break a correct program", () => {
    const p2 = learn(allExamples.slice(0, 2));
    const p5 = learn(allExamples.slice(0, 5));
    expect(p2).not.toBeNull();
    expect(p5).not.toBeNull();

    // Both should produce correct results on the same test input
    const testSources = ["Chris Evans"];
    const r2 = applyProgram(p2!, testSources);
    const r5 = applyProgram(p5!, testSources);
    expect(r2).toBe("Evans");
    expect(r5).toBe("Evans");
  });

  it("10 consistent examples all pass", () => {
    const manyExamples: Example[] = [
      { sources: ["a,b"], output: "b" },
      { sources: ["c,d"], output: "d" },
      { sources: ["e,f"], output: "f" },
      { sources: ["g,h"], output: "h" },
      { sources: ["i,j"], output: "j" },
      { sources: ["k,l"], output: "l" },
      { sources: ["m,n"], output: "n" },
      { sources: ["o,p"], output: "p" },
      { sources: ["q,r"], output: "r" },
      { sources: ["s,t"], output: "t" },
    ];
    const program = learn(manyExamples);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["u,v"])).toBe("v");
  });
});

// ============================================================================
// Contradictory / impossible examples
// ============================================================================

describe("contradictory and impossible examples", () => {
  it("returns null when same source maps to different outputs", () => {
    const program = learn([
      { sources: ["abc"], output: "a" },
      { sources: ["abc"], output: "c" },
    ]);
    expect(program).toBeNull();
  });

  it("returns null when examples require incompatible transforms", () => {
    // First wants uppercase, second wants lowercase
    const program = learn([
      { sources: ["hello"], output: "HELLO" },
      { sources: ["WORLD"], output: "world" },
    ]);
    expect(program).toBeNull();
  });

  it("returns null when output has no relation to source", () => {
    const program = learn([
      { sources: ["aaa"], output: "zzz" },
      { sources: ["bbb"], output: "yyy" },
    ]);
    expect(program).toBeNull();
  });

  it("returns null for empty example list", () => {
    expect(learn([])).toBeNull();
  });
});

// ============================================================================
// Patterns requiring only one operation type
// ============================================================================

describe("single-operation patterns", () => {
  it("only substring: extract fixed position", () => {
    const program = learn([
      { sources: ["ABCDE"], output: "BCD" },
      { sources: ["12345"], output: "234" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["VWXYZ"])).toBe("WXY");
  });

  it("only delimiter: split on comma, take first part", () => {
    const program = learn([
      { sources: ["alpha,beta,gamma"], output: "alpha" },
      { sources: ["one,two,three"], output: "one" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["x,y,z"])).toBe("x");
  });

  it("only case transform: uppercase entire string", () => {
    const program = learn([
      { sources: ["hello"], output: "HELLO" },
      { sources: ["world"], output: "WORLD" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["test"])).toBe("TEST");
  });

  it("only case transform: lowercase entire string", () => {
    const program = learn([
      { sources: ["ABC"], output: "abc" },
      { sources: ["XYZ"], output: "xyz" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["QRS"])).toBe("qrs");
  });

  it("only case transform: capitalize", () => {
    const program = learn([
      { sources: ["hELLO"], output: "Hello" },
      { sources: ["wORLD"], output: "World" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["tEST"])).toBe("Test");
  });
});

// ============================================================================
// Complex multi-step patterns (3+ operations)
// ============================================================================

describe("complex multi-step patterns (3+ operations)", () => {
  it("delimiter split + reorder + literal separator: 'Last, First' -> 'First Last'", () => {
    const program = learn([
      { sources: ["Smith, John"], output: "John Smith" },
      { sources: ["Doe, Jane"], output: "Jane Doe" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["Cooper, Alice"])).toBe("Alice Cooper");
  });

  it("delimiter split + case transform + literal: 'john smith' -> 'SMITH, john'", () => {
    const program = learn([
      { sources: ["john smith"], output: "SMITH, john" },
      { sources: ["jane doe"], output: "DOE, jane" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["alice cooper"])).toBe("COOPER, alice");
  });

  it("positional decomposition inserts multiple literals: '20240315' -> '2024/03/15'", () => {
    const program = learn([
      { sources: ["20240315"], output: "2024/03/15" },
      { sources: ["20231225"], output: "2023/12/25" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["20250704"])).toBe("2025/07/04");
  });

  it("delimiter reorder with changed delimiter: 'a/b/c' -> 'c-b-a'", () => {
    const program = learn([
      { sources: ["a/b/c"], output: "c-b-a" },
      { sources: ["x/y/z"], output: "z-y-x" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["p/q/r"])).toBe("r-q-p");
  });
});

// ============================================================================
// Program serialization / inspection
// ============================================================================

describe("program inspection", () => {
  it("learned program has expressions array", () => {
    const program = learn([{ sources: ["hello"], output: "HELLO" }]);
    expect(program).not.toBeNull();
    expect(Array.isArray(program!.expressions)).toBe(true);
    expect(program!.expressions.length).toBeGreaterThan(0);
  });

  it("expression types are valid enum values", () => {
    const validTypes = new Set(["constant", "substring", "delimSplit", "upper", "lower", "capitalize", "concat"]);
    const program = learn([
      { sources: ["Smith, John"], output: "John Smith" },
      { sources: ["Doe, Jane"], output: "Jane Doe" },
    ]);
    expect(program).not.toBeNull();

    function checkExpr(expr: any): void {
      expect(validTypes.has(expr.type)).toBe(true);
      if (expr.inner) checkExpr(expr.inner);
      if (expr.parts) expr.parts.forEach(checkExpr);
    }
    program!.expressions.forEach(checkExpr);
  });

  it("delimiter-based program contains delimSplit expression", () => {
    const program = learn([
      { sources: ["a,b,c"], output: "b" },
      { sources: ["x,y,z"], output: "y" },
    ]);
    expect(program).not.toBeNull();
    const hasDelimSplit = program!.expressions.some(
      (e) => e.type === "delimSplit" || (("inner" in e) && (e as any).inner?.type === "delimSplit"),
    );
    expect(hasDelimSplit).toBe(true);
  });

  it("program is JSON-serializable", () => {
    const program = learn([
      { sources: ["hello world"], output: "HELLO WORLD" },
    ]);
    expect(program).not.toBeNull();
    const json = JSON.stringify(program);
    const parsed = JSON.parse(json) as Program;
    expect(applyProgram(parsed, ["foo bar"])).toBe("FOO BAR");
  });
});

// ============================================================================
// Apply to unseen inputs
// ============================================================================

describe("applyProgram on unseen inputs", () => {
  it("delimiter program generalizes to longer parts", () => {
    const program = learn([
      { sources: ["a-b"], output: "b" },
      { sources: ["c-d"], output: "d" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["longfirst-longsecond"])).toBe("longsecond");
  });

  it("uppercase program works on same-length inputs", () => {
    const program = learn([
      { sources: ["hello"], output: "HELLO" },
      { sources: ["world"], output: "WORLD" },
    ]);
    expect(program).not.toBeNull();
    // The engine learns upper(substring(0, N)) so it works for same-length inputs
    expect(applyProgram(program!, ["tests"])).toBe("TESTS");
  });

  it("returns empty string when delimiter part index exceeds actual parts", () => {
    const program = learn([
      { sources: ["a,b,c"], output: "c" },
      { sources: ["x,y,z"], output: "z" },
    ]);
    expect(program).not.toBeNull();
    // Input with only 2 parts - partIndex 2 will be empty
    const result = applyProgram(program!, ["only,two"]);
    expect(result).toBe("");
  });
});

// ============================================================================
// Performance
// ============================================================================

describe("performance", () => {
  it("learns from 100 consistent examples under 2 seconds", () => {
    const examples: Example[] = [];
    for (let i = 0; i < 100; i++) {
      const first = `First${i}`;
      const last = `Last${i}`;
      examples.push({ sources: [`${first} ${last}`], output: last });
    }

    const start = performance.now();
    const program = learn(examples);
    const elapsed = performance.now() - start;

    expect(program).not.toBeNull();
    expect(elapsed).toBeLessThan(2000);
    expect(applyProgram(program!, ["NewFirst NewLast"])).toBe("NewLast");
  });
});

// ============================================================================
// Edge cases: varying source lengths, empty examples in middle
// ============================================================================

describe("edge cases with source lengths and empty values", () => {
  it("handles sources of wildly different lengths", () => {
    const program = learn([
      { sources: ["A-B"], output: "B" },
      { sources: ["VeryLongPrefix-ShortSuffix"], output: "ShortSuffix" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["X-Y"])).toBe("Y");
  });

  it("handles source that is just the delimiter", () => {
    const program = learn([
      { sources: ["a,b"], output: "a" },
      { sources: ["x,y"], output: "x" },
    ]);
    expect(program).not.toBeNull();
    // Source with only a comma: split gives ["",""]
    expect(applyProgram(program!, [","])).toBe("");
  });

  it("handles multi-source where one source is empty", () => {
    // Multi-source concat: first source + constant
    const program = learn([
      { sources: ["hello", ""], output: "hello" },
    ]);
    // Should learn substring of first source
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["hello", ""])).toBe("hello");
  });

  it("single-char sources with delimiter extraction", () => {
    const program = learn([
      { sources: ["a,b"], output: "a" },
      { sources: ["x,y"], output: "x" },
    ]);
    expect(program).not.toBeNull();
    expect(applyProgram(program!, ["z,w"])).toBe("z");
  });
});

// ============================================================================
// Adding more examples does not degrade a correct program
// ============================================================================

describe("monotonic quality: more examples do not degrade", () => {
  it("program from 2 examples works on test set; program from 4 also works", () => {
    const testInputs = ["Mike Brown", "Sue Park", "Al Z"];
    const expected = ["Brown", "Park", "Z"];

    const p2 = learn([
      { sources: ["John Smith"], output: "Smith" },
      { sources: ["Jane Doe"], output: "Doe" },
    ]);
    const p4 = learn([
      { sources: ["John Smith"], output: "Smith" },
      { sources: ["Jane Doe"], output: "Doe" },
      { sources: ["Alexandra Jones"], output: "Jones" },
      { sources: ["Bo Li"], output: "Li" },
    ]);

    expect(p2).not.toBeNull();
    expect(p4).not.toBeNull();

    for (let i = 0; i < testInputs.length; i++) {
      expect(applyProgram(p2!, [testInputs[i]])).toBe(expected[i]);
      expect(applyProgram(p4!, [testInputs[i]])).toBe(expected[i]);
    }
  });

  it("adding a 5th example preserves correctness of 3-example program", () => {
    const base: Example[] = [
      { sources: ["a-b-c"], output: "b" },
      { sources: ["x-y-z"], output: "y" },
      { sources: ["1-2-3"], output: "2" },
    ];
    const extended = [...base, { sources: ["p-q-r"], output: "q" }, { sources: ["d-e-f"], output: "e" }];

    const p3 = learn(base);
    const p5 = learn(extended);
    expect(p3).not.toBeNull();
    expect(p5).not.toBeNull();

    expect(applyProgram(p3!, ["m-n-o"])).toBe("n");
    expect(applyProgram(p5!, ["m-n-o"])).toBe("n");
  });
});
