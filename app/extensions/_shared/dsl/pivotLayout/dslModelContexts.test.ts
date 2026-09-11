//! FILENAME: app/extensions/_shared/dsl/pivotLayout/dslModelContexts.test.ts
// PURPOSE: One editor, one context — the bug that let two open design-query
//          editors autocomplete against each other's schema.
// CONTEXT: Monaco registers a provider per LANGUAGE, so the only thing that can
//          tell two documents apart is the model handed to the provider. Before
//          this registry the context was a set of module-level "current" fields
//          written by whichever editor rendered last, and the Reports dialog and
//          the pivot's Design tab can be open together. `pivotDslLanguage.ts`
//          had no test file at all, which is why nothing said so.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearDslModelContext,
  dslContextForUri,
  dslModelContextCount,
  resetDslModelContexts,
  setDslControlHints,
  setDslEditorContext,
  setDslModelContext,
  type DslModelContext,
} from "./dslModelContexts";
import type { BiPivotModelInfo } from "../../components/types";

const modelNamed = (name: string): BiPivotModelInfo =>
  ({ tables: [{ name, columns: [] }], measures: [] }) as unknown as BiPivotModelInfo;

const ctx = (name: string): DslModelContext => ({
  sourceFields: [],
  controlHints: [],
  biModel: modelNamed(name),
});

beforeEach(() => resetDslModelContexts());

describe("one context per document", () => {
  it("keeps two open editors apart", () => {
    // THE BUG, stated as a test. Both hosts write on every model change; before
    // the registry the second write replaced the first and the first editor
    // then completed against the second's schema.
    setDslModelContext("inmemory://model/1", ctx("Reports"));
    setDslModelContext("inmemory://model/2", ctx("PivotTab"));
    expect(dslContextForUri("inmemory://model/1").biModel?.tables[0].name).toBe("Reports");
    expect(dslContextForUri("inmemory://model/2").biModel?.tables[0].name).toBe("PivotTab");
  });

  it("re-registering one document does not disturb the other", () => {
    setDslModelContext("a", ctx("First"));
    setDslModelContext("b", ctx("Second"));
    setDslModelContext("a", ctx("FirstAgain"));
    expect(dslContextForUri("a").biModel?.tables[0].name).toBe("FirstAgain");
    expect(dslContextForUri("b").biModel?.tables[0].name).toBe("Second");
  });

  it("forgets a document when its editor unmounts, and leaks nothing", () => {
    setDslModelContext("a", ctx("First"));
    setDslModelContext("b", ctx("Second"));
    expect(dslModelContextCount()).toBe(2);
    clearDslModelContext("a");
    expect(dslModelContextCount()).toBe(1);
    // ...and the forgotten one falls back rather than returning the other's.
    expect(dslContextForUri("a").biModel).toBeUndefined();
    expect(dslContextForUri("b").biModel?.tables[0].name).toBe("Second");
  });
});

describe("the fallback", () => {
  it("answers for a document nobody registered", () => {
    // The window between a host's `biModel` effect and its editor mounting.
    setDslEditorContext([], modelNamed("Fallback"));
    expect(dslContextForUri("never-registered").biModel?.tables[0].name).toBe("Fallback");
    expect(dslContextForUri(null).biModel?.tables[0].name).toBe("Fallback");
  });

  it("never overrides a document that HAS a context", () => {
    // The whole point: a late fallback write must not reach a registered editor,
    // or the old last-writer-wins bug comes back through the back door.
    setDslModelContext("a", ctx("Mine"));
    setDslEditorContext([], modelNamed("SomebodyElse"));
    expect(dslContextForUri("a").biModel?.tables[0].name).toBe("Mine");
  });

  it("clears control hints without losing the rest of the fallback", () => {
    setDslEditorContext([], modelNamed("Fallback"), [{ name: "Region" }]);
    expect(dslContextForUri(null).controlHints).toHaveLength(1);
    setDslControlHints([]);
    expect(dslContextForUri(null).controlHints).toHaveLength(0);
    expect(dslContextForUri(null).biModel?.tables[0].name, "the model survives").toBe("Fallback");
  });
});
