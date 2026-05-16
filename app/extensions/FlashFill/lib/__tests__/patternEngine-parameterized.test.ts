//! FILENAME: app/extensions/FlashFill/lib/__tests__/patternEngine-parameterized.test.ts
// PURPOSE: Parameterized tests for FlashFill pattern engine - learning and application.

import { describe, it, expect } from "vitest";
import { learn, applyProgram, Example, Program, Expression } from "../../lib/patternEngine";

// ============================================================================
// All program/expression types x input patterns (30 tests)
// ============================================================================

describe("applyProgram - all expression types x input patterns", () => {
  const inputs = [
    { name: "simple-name", sources: ["John Smith"] },
    { name: "email", sources: ["john@example.com"] },
    { name: "date-string", sources: ["2024-03-15"] },
    { name: "csv-like", sources: ["Alice,30,Engineer"] },
    { name: "path-like", sources: ["usr/local/bin"] },
  ];

  // constant expression
  describe("constant expression", () => {
    it.each(inputs)(
      "constant with $name input",
      ({ sources }) => {
        const program: Program = { expressions: [{ type: "constant", value: "FIXED" }] };
        expect(applyProgram(program, sources)).toBe("FIXED");
      },
    );
  });

  // substring expression
  describe("substring expression", () => {
    it.each(inputs)(
      "substring(0,4) with $name input",
      ({ sources }) => {
        const program: Program = {
          expressions: [{ type: "substring", sourceIndex: 0, start: 0, end: 4 }],
        };
        expect(applyProgram(program, sources)).toBe(sources[0].substring(0, 4));
      },
    );
  });

  // upper expression
  describe("upper expression", () => {
    it.each(inputs)(
      "upper with $name input",
      ({ sources }) => {
        const program: Program = {
          expressions: [{ type: "upper", inner: { type: "substring", sourceIndex: 0, start: 0, end: sources[0].length } }],
        };
        expect(applyProgram(program, sources)).toBe(sources[0].toUpperCase());
      },
    );
  });

  // lower expression
  describe("lower expression", () => {
    it.each(inputs)(
      "lower with $name input",
      ({ sources }) => {
        const program: Program = {
          expressions: [{ type: "lower", inner: { type: "substring", sourceIndex: 0, start: 0, end: sources[0].length } }],
        };
        expect(applyProgram(program, sources)).toBe(sources[0].toLowerCase());
      },
    );
  });

  // capitalize expression
  describe("capitalize expression", () => {
    it.each(inputs)(
      "capitalize with $name input",
      ({ sources }) => {
        const program: Program = {
          expressions: [{ type: "capitalize", inner: { type: "substring", sourceIndex: 0, start: 0, end: sources[0].length } }],
        };
        const expected = sources[0].charAt(0).toUpperCase() + sources[0].slice(1).toLowerCase();
        expect(applyProgram(program, sources)).toBe(expected);
      },
    );
  });

  // concat expression
  describe("concat expression", () => {
    it.each(inputs)(
      "concat with $name input",
      ({ sources }) => {
        const program: Program = {
          expressions: [{
            type: "concat",
            parts: [
              { type: "substring", sourceIndex: 0, start: 0, end: 2 },
              { type: "constant", value: "-" },
              { type: "substring", sourceIndex: 0, start: 2, end: 4 },
            ],
          }],
        };
        const expected = sources[0].substring(0, 2) + "-" + sources[0].substring(2, 4);
        expect(applyProgram(program, sources)).toBe(expected);
      },
    );
  });
});

// ============================================================================
// learn with varying example counts (10 patterns x {1,2,3,5} examples = 40 tests)
// ============================================================================

describe("learn - varying example counts", () => {
  const patterns = [
    {
      name: "first-name-extraction",
      genExample: (i: number): Example => ({
        sources: [["John Smith", "Jane Doe", "Bob Jones", "Alice Brown", "Tom White"][i]],
        output: ["John", "Jane", "Bob", "Alice", "Tom"][i],
      }),
    },
    {
      name: "last-name-extraction",
      genExample: (i: number): Example => ({
        sources: [["John Smith", "Jane Doe", "Bob Jones", "Alice Brown", "Tom White"][i]],
        output: ["Smith", "Doe", "Jones", "Brown", "White"][i],
      }),
    },
    {
      name: "uppercase-transform",
      genExample: (i: number): Example => ({
        sources: [["hello", "world", "test", "data", "flash"][i]],
        output: ["HELLO", "WORLD", "TEST", "DATA", "FLASH"][i],
      }),
    },
    {
      name: "lowercase-transform",
      genExample: (i: number): Example => ({
        sources: [["HELLO", "WORLD", "TEST", "DATA", "FLASH"][i]],
        output: ["hello", "world", "test", "data", "flash"][i],
      }),
    },
    {
      name: "email-domain",
      genExample: (i: number): Example => ({
        sources: [["john@gmail.com", "jane@yahoo.com", "bob@outlook.com", "alice@gmail.com", "tom@yahoo.com"][i]],
        output: ["gmail.com", "yahoo.com", "outlook.com", "gmail.com", "yahoo.com"][i],
      }),
    },
    {
      name: "comma-separated-reorder",
      genExample: (i: number): Example => ({
        sources: [["Smith, John", "Doe, Jane", "Jones, Bob", "Brown, Alice", "White, Tom"][i]],
        output: ["John Smith", "Jane Doe", "Bob Jones", "Alice Brown", "Tom White"][i],
      }),
    },
    {
      name: "pipe-first-field",
      genExample: (i: number): Example => ({
        sources: [["red|green", "cat|dog", "up|down", "sun|moon", "hot|cold"][i]],
        output: ["red", "cat", "up", "sun", "hot"][i],
      }),
    },
    {
      name: "first-3-chars",
      genExample: (i: number): Example => ({
        sources: [["January", "February", "March", "April", "May00"][i]],
        output: ["Jan", "Feb", "Mar", "Apr", "May"][i],
      }),
    },
    {
      name: "capitalize-word",
      genExample: (i: number): Example => ({
        sources: [["hello", "world", "test", "data", "flash"][i]],
        output: ["Hello", "World", "Test", "Data", "Flash"][i],
      }),
    },
    {
      name: "csv-field-extract",
      genExample: (i: number): Example => ({
        sources: [["a,b,c", "d,e,f", "g,h,i", "j,k,l", "m,n,o"][i]],
        output: ["b", "e", "h", "k", "n"][i],
      }),
    },
  ];

  const exampleCounts = [1, 2, 3, 5];

  const combos = patterns.flatMap((p) =>
    exampleCounts.map((count) => ({
      patternName: p.name,
      count,
      genExample: p.genExample,
    })),
  );

  it.each(combos)(
    "learns $patternName from $count example(s)",
    ({ count, genExample }) => {
      const examples: Example[] = [];
      for (let i = 0; i < count; i++) {
        examples.push(genExample(i));
      }
      const program = learn(examples);
      // With at least 1 example, should find a pattern
      expect(program).not.toBeNull();
      // Verify it works on all provided examples
      for (const ex of examples) {
        expect(applyProgram(program!, ex.sources)).toBe(ex.output);
      }
    },
  );
});

// ============================================================================
// applyProgram on unseen inputs for learned programs (10 patterns x 2 unseen = 20 tests)
// ============================================================================

describe("applyProgram - generalization to unseen inputs", () => {
  const learnAndApplyCases = [
    {
      name: "first-name",
      trainExamples: [
        { sources: ["John Smith"], output: "John" },
        { sources: ["Jane Doe"], output: "Jane" },
      ],
      unseenInputs: [
        { sources: ["Bob Jones"], expected: "Bob" },
        { sources: ["Alice Brown"], expected: "Alice" },
      ],
    },
    {
      name: "last-name",
      trainExamples: [
        { sources: ["John Smith"], output: "Smith" },
        { sources: ["Jane Doe"], output: "Doe" },
      ],
      unseenInputs: [
        { sources: ["Bob Jones"], expected: "Jones" },
        { sources: ["Alice Brown"], expected: "Brown" },
      ],
    },
    {
      name: "uppercase",
      trainExamples: [
        { sources: ["hello"], output: "HELLO" },
        { sources: ["world"], output: "WORLD" },
      ],
      unseenInputs: [
        { sources: ["flash"], expected: "FLASH" },
        { sources: ["fill"], expected: "FILL" },
      ],
    },
    {
      name: "lowercase",
      trainExamples: [
        { sources: ["HELLO"], output: "hello" },
        { sources: ["WORLD"], output: "world" },
      ],
      unseenInputs: [
        { sources: ["FLASH"], expected: "flash" },
        { sources: ["FILL"], expected: "fill" },
      ],
    },
    {
      name: "email-domain",
      trainExamples: [
        { sources: ["john@gmail.com"], output: "gmail.com" },
        { sources: ["jane@yahoo.com"], output: "yahoo.com" },
      ],
      unseenInputs: [
        { sources: ["bob@outlook.com"], expected: "outlook.com" },
        { sources: ["alice@hotmail.com"], expected: "hotmail.com" },
      ],
    },
    {
      name: "capitalize",
      trainExamples: [
        { sources: ["hello"], output: "Hello" },
        { sources: ["world"], output: "World" },
      ],
      unseenInputs: [
        { sources: ["flash"], expected: "Flash" },
        { sources: ["data"], expected: "Data" },
      ],
    },
    {
      name: "csv-second-field",
      trainExamples: [
        { sources: ["a,b,c"], output: "b" },
        { sources: ["d,e,f"], output: "e" },
      ],
      unseenInputs: [
        { sources: ["g,h,i"], expected: "h" },
        { sources: ["j,k,l"], expected: "k" },
      ],
    },
    {
      name: "name-reorder",
      trainExamples: [
        { sources: ["Smith, John"], output: "John Smith" },
        { sources: ["Doe, Jane"], output: "Jane Doe" },
      ],
      unseenInputs: [
        { sources: ["Jones, Bob"], expected: "Bob Jones" },
        { sources: ["Brown, Alice"], expected: "Alice Brown" },
      ],
    },
    {
      name: "multi-source-concat",
      trainExamples: [
        { sources: ["John", "Smith"], output: "John Smith" },
        { sources: ["Jane", "Jones"], output: "Jane Jones" },
      ],
      unseenInputs: [
        { sources: ["Mark", "Brown"], expected: "Mark Brown" },
        { sources: ["Sara", "White"], expected: "Sara White" },
      ],
    },
    {
      name: "pipe-split-first",
      trainExamples: [
        { sources: ["red|green|blue"], output: "red" },
        { sources: ["cat|dog|fish"], output: "cat" },
      ],
      unseenInputs: [
        { sources: ["up|down|left"], expected: "up" },
        { sources: ["sun|moon|star"], expected: "sun" },
      ],
    },
  ];

  const flatCases = learnAndApplyCases.flatMap((c) =>
    c.unseenInputs.map((unseen, i) => ({
      name: c.name,
      unseenIndex: i,
      trainExamples: c.trainExamples,
      sources: unseen.sources,
      expected: unseen.expected,
    })),
  );

  it.each(flatCases)(
    "$name generalizes to unseen input #$unseenIndex",
    ({ trainExamples, sources, expected }) => {
      const program = learn(trainExamples);
      expect(program).not.toBeNull();
      const result = applyProgram(program!, sources);
      expect(result).toBe(expected);
    },
  );
});
