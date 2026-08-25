// FILENAME: app/extensions/ModelEditor/components/transform/__tests__/stepKit.test.ts
// PURPOSE:  The step editor's pure half — the step vocabulary, the seeded
//           defaults, and the human descriptions — plus the cross-layer drift
//           guard that keeps three copies of that vocabulary honest.
//
// WHY THE DRIFT GUARD MATTERS MOST. The step catalog is written down THREE
// times: the engine's `TransformStep` enum (Rust, authoritative), the step
// picker's `STEP_TYPES` (this folder), and the CLI's `TRANSFORM_STEP_TYPES`.
// Nothing but this file makes them agree. A step added to the engine and
// forgotten here is invisible in the editor; a tag misspelled here produces a
// step the engine refuses at save time, which the user meets as a failed edit
// with no obvious cause. The Rust file is read at test time, so the engine
// stays the single source of truth — the same technique
// `writebackGateway.test.ts` uses for the gateway kind set.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  STEP_GROUPS,
  STEP_TYPES,
  defaultStep,
  describeStep,
  stepDetail,
  stepTypeInfo,
  stepTypeLabel,
  summarizeSteps,
} from "../stepKit";
import { TRANSFORM_STEP_TYPES, normalizeStepType } from "../../../cli/transformSteps";
import type { ModelColumnInfo, TransformStepDto } from "@api";

/** The engine's serialized step tags, read from the Rust source. */
function engineStepTags(): string[] {
  const stepRs = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../../../model-engine-lib/crates/engine-core/src/transform/step.rs",
    ),
    "utf8",
  );
  // `type_name()` carries the exact serde tag for every variant, one arm each.
  const tags = [...stepRs.matchAll(/TransformStep::\w+\s*\{\s*\.\.\s*\}\s*=>\s*"([A-Za-z]+)"/g)].map(
    (m) => m[1],
  );
  return tags.sort();
}

const columns: ModelColumnInfo[] = [
  { name: "id", dataType: "Int64" },
  { name: "status", dataType: "String" },
  { name: "amount", dataType: "Float64" },
] as ModelColumnInfo[];

describe("the step vocabulary matches the engine", () => {
  const engineTags = engineStepTags();

  it("reads a non-empty catalog out of the Rust source", () => {
    // Without this the two assertions below would pass vacuously if the regex
    // ever stopped matching (a refactor of `type_name`, a rename of the file).
    expect(engineTags.length).toBeGreaterThan(10);
    expect(engineTags).toContain("filterRows");
  });

  it("the step picker offers exactly the engine's steps", () => {
    expect([...STEP_TYPES.map((t) => t.value)].sort()).toEqual(engineTags);
  });

  it("the CLI accepts exactly the engine's steps", () => {
    expect([...TRANSFORM_STEP_TYPES].sort()).toEqual(engineTags);
  });
});

/**
 * The engine's step FIELD names, in their serialized (camelCase) spelling.
 *
 * `TransformStep` carries `rename_all_fields = "camelCase"`, so a Rust field
 * `keep_original` serializes as `keepOriginal`. Extracting the declarations and
 * converting is enough for what this guards against: a field name invented on
 * the TypeScript side that exists nowhere in the engine.
 */
function engineFieldNames(): Set<string> {
  const stepRs = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../../../model-engine-lib/crates/engine-core/src/transform/step.rs",
    ),
    "utf8",
  );
  const enumBody = stepRs.match(/pub enum TransformStep \{([\s\S]*?)\n\}/);
  if (!enumBody) throw new Error("could not find `pub enum TransformStep` in step.rs");
  const snake = [...enumBody[1].matchAll(/^\s+([a-z][a-z0-9_]*)\s*:\s*\S/gm)].map((m) => m[1]);
  const camel = snake.map((s) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()));
  return new Set(camel);
}

describe("step field names match the engine", () => {
  const engineFields = engineFieldNames();

  it("extracts a real field set from the Rust source", () => {
    expect(engineFields.size).toBeGreaterThan(10);
    // A snake_case field must have arrived camelCased, or the conversion is
    // broken and every assertion below would be comparing the wrong spelling.
    expect(engineFields.has("keepOriginal")).toBe(true);
    expect(engineFields.has("keep_original")).toBe(false);
  });

  it("every seeded default uses only fields the engine declares", () => {
    // The failure this catches: a step that looks right in the editor and is
    // refused by the engine on Apply, with the user seeing only a failed edit.
    for (const { value } of STEP_TYPES) {
      const step = defaultStep(value, columns) as Record<string, unknown>;
      for (const key of Object.keys(step)) {
        if (key === "type") continue;
        expect(
          engineFields.has(key),
          `step '${value}' emits field '${key}', which the engine's TransformStep does not declare`,
        ).toBe(true);
      }
    }
  });
});

describe("STEP_TYPES", () => {
  it("gives every step a group the picker actually renders", () => {
    for (const step of STEP_TYPES) {
      expect(STEP_GROUPS, `step '${step.value}' has an unrenderable group`).toContain(step.group);
    }
  });

  it("gives every step a distinct label and a hint", () => {
    const labels = STEP_TYPES.map((t) => t.label);
    expect(new Set(labels).size, "two steps share a label").toBe(labels.length);
    for (const step of STEP_TYPES) {
      expect(step.hint.length, `step '${step.value}' has no hint`).toBeGreaterThan(10);
    }
  });

  it("looks a step up by tag and falls back to the tag when unknown", () => {
    expect(stepTypeInfo("filterRows")?.label).toBeTruthy();
    expect(stepTypeInfo("nonsense")).toBeUndefined();
    // An unknown tag must render as itself rather than as "undefined" — a
    // model written by a newer engine can carry a step this build lacks.
    expect(stepTypeLabel("nonsense")).toBe("nonsense");
  });
});

describe("defaultStep", () => {
  it("produces a step whose type tag is the one asked for", () => {
    for (const { value } of STEP_TYPES) {
      expect(defaultStep(value, columns).type).toBe(value);
    }
  });

  it("seeds pickers from real columns rather than placeholders", () => {
    // The point of seeding: a freshly added step opens on something that
    // exists, so the first preview shows data instead of an error.
    const rename = defaultStep("renameColumns", columns);
    expect(rename.renames?.[0]?.from).toBe("id");

    const split = defaultStep("splitColumn", columns);
    expect(split.column, "split needs a TEXT column, not merely the first one").toBe("status");
  });

  it("starts 'choose columns' from the full set and 'remove columns' from none", () => {
    // Opposite directions on purpose: choosing is subtractive, removing is
    // additive. Getting this backwards silently empties a table on the first
    // apply.
    expect(defaultStep("selectColumns", columns).columns).toEqual(["id", "status", "amount"]);
    expect(defaultStep("removeColumns", columns).columns).toEqual([]);
  });

  it("does not throw when the table has no columns yet", () => {
    for (const { value } of STEP_TYPES) {
      expect(() => defaultStep(value, []), `defaultStep('${value}') on an empty table`).not.toThrow();
    }
  });
});

describe("describeStep", () => {
  it("names every step type without falling through to a raw tag", () => {
    for (const { value } of STEP_TYPES) {
      const described = describeStep(defaultStep(value, columns));
      expect(described, `step '${value}' has no description`).toBeTruthy();
      expect(described, `step '${value}' fell through to its raw tag`).not.toBe(value);
    }
  });

  it("agrees in number with what the step actually carries", () => {
    expect(describeStep({ type: "removeColumns", columns: ["a"] })).toBe("Remove column");
    expect(describeStep({ type: "removeColumns", columns: ["a", "b"] })).toBe("Remove 2 columns");
  });

  it("uses the object's own name where the user gave one", () => {
    expect(describeStep({ type: "addColumn", name: "margin", expression: "a-b" })).toContain(
      "margin",
    );
    // ...and stays sensible before they have.
    expect(describeStep({ type: "addColumn", expression: "" })).toBe("Add column");
  });
});

describe("stepDetail", () => {
  it("returns a string for every step type", () => {
    for (const { value } of STEP_TYPES) {
      expect(typeof stepDetail(defaultStep(value, columns))).toBe("string");
    }
  });
});

describe("summarizeSteps", () => {
  it("says so plainly when there is no pipeline", () => {
    expect(summarizeSteps([])).toBe("No transformation steps.");
  });

  it("counts and lists the steps", () => {
    const steps: TransformStepDto[] = [
      { type: "filterRows", condition: 'status <> "cancelled"' },
      { type: "removeColumns", columns: ["note"] },
    ];
    const summary = summarizeSteps(steps);
    expect(summary).toContain("2 steps");
    expect(summary).toContain("Filter rows");
    expect(summary).toContain("Remove column");
  });

  it("uses the singular for one step", () => {
    expect(summarizeSteps([{ type: "filterRows", condition: "x > 0" }])).toContain("1 step:");
  });

  it("elides a long pipeline instead of running off the card", () => {
    const many: TransformStepDto[] = Array.from({ length: 7 }, () => ({
      type: "filterRows",
      condition: "x > 0",
    }));
    const summary = summarizeSteps(many, 4);
    expect(summary).toContain("7 steps");
    expect(summary).toContain("+3 more");
  });
});

describe("the CLI's step-name normalizer", () => {
  it("accepts the engine's own tag for every step", () => {
    for (const tag of TRANSFORM_STEP_TYPES) {
      expect(normalizeStepType(tag), `'${tag}' is not accepted by its own name`).toBe(tag);
    }
  });

  it("is case-insensitive, because a CLI user is typing", () => {
    expect(normalizeStepType("filterrows")).toBe("filterRows");
    expect(normalizeStepType("FILTERROWS")).toBe("filterRows");
  });

  it("refuses an unknown step rather than guessing", () => {
    expect(normalizeStepType("teleportRows")).toBeNull();
  });
});
