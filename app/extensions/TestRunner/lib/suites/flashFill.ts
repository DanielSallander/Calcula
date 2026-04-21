//! FILENAME: app/extensions/TestRunner/lib/suites/flashFill.ts
// PURPOSE: Tests for the Flash Fill pattern engine.
// CONTEXT: Verifies pattern detection, learning, and application for various
//          transformation types. Tests the engine directly since the Flash Fill
//          extension registers its command via object syntax which doesn't match
//          CommandRegistry.register(id, handler) — the command only works via
//          keyboard shortcut (Ctrl+E) and menu item, not via executeCommand().

import type { TestSuite } from "../types";
import { AREA_FLASH_FILL } from "../testArea";
import { learn, applyProgram } from "../../../FlashFill/lib/patternEngine";

const A = AREA_FLASH_FILL;

export const flashFillSuite: TestSuite = {
  name: "Flash Fill",
  description: "Tests Flash Fill pattern engine detection and application.",

  tests: [
    {
      name: "First name extraction (delimiter split)",
      async run(ctx) {
        const program = learn([{ sources: ["John Smith"], output: "John" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const results = [
          { input: "Jane Doe", expected: "Jane" },
          { input: "Bob Wilson", expected: "Bob" },
          { input: "Alice Brown", expected: "Alice" },
        ];
        for (const { input, expected } of results) {
          const result = applyProgram(program, [input]);
          if (result !== expected) {
            throw new Error(`Expected "${expected}" from "${input}", got "${result}"`);
          }
        }
      },
    },
    {
      name: "Last name extraction (delimiter split)",
      async run(ctx) {
        const program = learn([{ sources: ["John Smith"], output: "Smith" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const results = [
          { input: "Jane Doe", expected: "Doe" },
          { input: "Bob Wilson", expected: "Wilson" },
        ];
        for (const { input, expected } of results) {
          const result = applyProgram(program, [input]);
          if (result !== expected) {
            throw new Error(`Expected "${expected}" from "${input}", got "${result}"`);
          }
        }
      },
    },
    {
      name: "Uppercase transformation",
      async run(ctx) {
        const program = learn([{ sources: ["hello"], output: "HELLO" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const r1 = applyProgram(program, ["world"]);
        if (r1 !== "WORLD") throw new Error(`Expected "WORLD", got "${r1}"`);
        const r2 = applyProgram(program, ["test"]);
        if (r2 !== "TEST") throw new Error(`Expected "TEST", got "${r2}"`);
      },
    },
    {
      name: "Lowercase transformation",
      async run(ctx) {
        const program = learn([{ sources: ["HELLO"], output: "hello" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const result = applyProgram(program, ["WORLD"]);
        if (result !== "world") throw new Error(`Expected "world", got "${result}"`);
      },
    },
    {
      name: "Delimiter extraction (email to domain)",
      async run(ctx) {
        const program = learn([{ sources: ["user@example.com"], output: "example.com" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const results = [
          { input: "admin@test.org", expected: "test.org" },
          { input: "info@company.net", expected: "company.net" },
        ];
        for (const { input, expected } of results) {
          const result = applyProgram(program, [input]);
          if (result !== expected) {
            throw new Error(`Expected "${expected}" from "${input}", got "${result}"`);
          }
        }
      },
    },
    {
      name: "Delimiter extraction (email to username)",
      async run(ctx) {
        const program = learn([{ sources: ["user@example.com"], output: "user" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const result = applyProgram(program, ["admin@test.org"]);
        if (result !== "admin") throw new Error(`Expected "admin", got "${result}"`);
      },
    },
    {
      name: "Multiple examples refine pattern",
      async run(ctx) {
        // Two examples to ensure the pattern generalizes
        const program = learn([
          { sources: ["John Smith"], output: "John" },
          { sources: ["Jane Doe"], output: "Jane" },
        ]);
        if (!program) throw new Error("Expected pattern to be learned with 2 examples");
        const result = applyProgram(program, ["Bob Wilson"]);
        if (result !== "Bob") throw new Error(`Expected "Bob", got "${result}"`);
      },
    },
    {
      name: "Inconsistent examples return null",
      async run(ctx) {
        // These examples are contradictory — no consistent pattern
        const program = learn([
          { sources: ["John Smith"], output: "John" },
          { sources: ["Jane Doe"], output: "Doe" },
        ]);
        if (program !== null) {
          throw new Error("Expected null for inconsistent examples");
        }
      },
    },
    {
      name: "Comma-separated value extraction",
      async run(ctx) {
        const program = learn([{ sources: ["Smith, John"], output: "John" }]);
        if (!program) throw new Error("Expected pattern to be learned");
        const result = applyProgram(program, ["Doe, Jane"]);
        if (result !== "Jane") throw new Error(`Expected "Jane", got "${result}"`);
      },
    },
  ],
};
