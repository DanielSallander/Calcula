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

/** Read one file out of the engine's `transform` module. */
function engineSource(file: "step.rs" | "parts.rs"): string {
  return fs.readFileSync(
    path.resolve(
      __dirname,
      `../../../../../../model-engine-lib/crates/engine-core/src/transform/${file}`,
    ),
    "utf8",
  );
}

/** The engine's serialized step tags, read from the Rust source. */
function engineStepTags(): string[] {
  const stepRs = engineSource("step.rs");
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

const SNAKE_TO_CAMEL = (s: string): string =>
  s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The bodies of every top-level `pub struct` / `pub enum` in a Rust source.
 *
 * Restricting to type bodies is what makes the field regex below safe: an
 * `impl` block (`Self { from: from.into() }`) and a `#[cfg(test)]` module
 * (`RowRange::Range { offset: 2, count: 5 }`) are full of `name: value` pairs
 * that are not field DECLARATIONS. Both are indented under an `impl`/`mod`, so
 * anchoring on a column-0 `pub struct`/`pub enum` and closing on a column-0 `}`
 * excludes them.
 */
function rustTypeBodies(source: string): string[] {
  return [...source.matchAll(/^pub (?:struct|enum) \w+ \{([\s\S]*?)\n\}/gm)].map((m) => m[1]);
}

/**
 * The engine's transformation FIELD names, in their serialized (camelCase)
 * spelling — from BOTH files that contribute them.
 *
 * `step.rs` declares the step variants; `parts.rs` declares the OPERAND types
 * those variants carry (`ColumnRename{from,to}`, `TypeChange{column,new_type}`,
 * `SortKey{column,descending}`, `GroupAggregate{column,function,alias}`,
 * `RowRange{kind,count,offset}`). Nothing in `app/` reads parts.rs, so before
 * this guard covered it a rename of `SortKey.descending` left every check green
 * while every saved sort step silently flipped back to ascending.
 *
 * Both files carry `rename_all_fields`/`rename_all = "camelCase"`, so a Rust
 * `new_type` serializes as `newType`. The internally tagged enums' TAG names
 * (`type` on `TransformStep`, `kind` on `RowRange`) are keys in the JSON too,
 * so they are collected from the `tag = "…"` attributes rather than guessed.
 */
function engineFieldNames(): Set<string> {
  const sources = [engineSource("step.rs"), engineSource("parts.rs")];
  const names = new Set<string>();
  for (const source of sources) {
    for (const tag of source.matchAll(/\btag\s*=\s*"([a-z][a-zA-Z0-9_]*)"/g)) {
      names.add(SNAKE_TO_CAMEL(tag[1]));
    }
    for (const body of rustTypeBodies(source)) {
      for (const field of body.matchAll(/^\s+(?:pub\s+)?([a-z][a-z0-9_]*)\s*:\s*\S/gm)) {
        names.add(SNAKE_TO_CAMEL(field[1]));
      }
    }
  }
  if (!names.has("condition")) {
    throw new Error("could not extract TransformStep's fields from step.rs");
  }
  return names;
}

/**
 * Every object key `value` contains, at any depth, with the path that reached
 * it. Arrays are walked into, because a step's operands live in them
 * (`renames: [{ from, to }]`, `by: [{ column, descending }]`).
 */
function objectKeysDeep(
  value: unknown,
  trail: string[] = [],
  out: Array<{ key: string; path: string }> = [],
): Array<{ key: string; path: string }> {
  if (Array.isArray(value)) {
    for (const item of value) objectKeysDeep(item, trail, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const here = [...trail, key];
      out.push({ key, path: here.join(".") });
      objectKeysDeep(child, here, out);
    }
  }
  return out;
}

describe("step field names match the engine", () => {
  const engineFields = engineFieldNames();

  it("extracts a real field set from step.rs", () => {
    expect(engineFields.size).toBeGreaterThan(10);
    // A snake_case field must have arrived camelCased, or the conversion is
    // broken and every assertion below would be comparing the wrong spelling.
    expect(engineFields.has("keepOriginal")).toBe(true);
    expect(engineFields.has("keep_original")).toBe(false);
    // The step tag itself is a key in the JSON, taken from `tag = "type"`.
    expect(engineFields.has("type")).toBe(true);
  });

  it("extracts the NESTED operand fields from parts.rs", () => {
    // Non-vacuity for the second source: these names exist ONLY in parts.rs,
    // so if its extraction silently produced nothing the assertion below would
    // pass while guarding half of what it claims to.
    expect(engineFields.has("newType"), "TypeChange::new_type").toBe(true);
    expect(engineFields.has("new_type"), "snake_case must not survive").toBe(false);
    expect(engineFields.has("descending"), "SortKey::descending").toBe(true);
    expect(engineFields.has("alias"), "GroupAggregate::alias").toBe(true);
    expect(engineFields.has("from"), "ColumnRename::from").toBe(true);
    expect(engineFields.has("to"), "ColumnRename::to").toBe(true);
    // RowRange is tagged on `kind`, and its variants carry count/offset.
    expect(engineFields.has("kind"), "RowRange's serde tag").toBe(true);
    expect(engineFields.has("count"), "RowRange::FirstN::count").toBe(true);
    expect(engineFields.has("offset"), "RowRange::Range::offset").toBe(true);
    expect(engineFields.has("range"), "TransformStep::KeepRows::range").toBe(true);
    // The body scanner itself must still be finding parts.rs's types: every
    // assertion above would survive a scanner that returned one lucky body.
    expect(rustTypeBodies(engineSource("parts.rs")).length).toBeGreaterThanOrEqual(7);
  });

  it("every seeded default uses only fields the engine declares, NESTED ONES TOO", () => {
    // The failure this catches: a step that looks right in the editor and is
    // refused by the engine on Apply, with the user seeing only a failed edit —
    // or worse, one the engine ACCEPTS while dropping the misspelled operand,
    // which is how a descending sort would come back ascending.
    let checked = 0;
    for (const { value } of STEP_TYPES) {
      const step = defaultStep(value, columns) as Record<string, unknown>;
      for (const { key, path } of objectKeysDeep(step)) {
        checked += 1;
        expect(
          engineFields.has(key),
          `step '${value}' emits field '${path}', which the engine's transform module does not declare`,
        ).toBe(true);
      }
    }
    // The loop must actually have reached nested keys: `renameColumns` alone
    // contributes `renames.from`, and a walker that stopped at the top level
    // would never see it.
    expect(checked).toBeGreaterThan(STEP_TYPES.length);
    const renameKeys = objectKeysDeep(defaultStep("renameColumns", columns)).map((k) => k.path);
    expect(renameKeys).toContain("renames.from");
    const sortKeys = objectKeysDeep(defaultStep("sort", columns)).map((k) => k.path);
    expect(sortKeys).toContain("by.descending");
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
