//! FILENAME: app/extensions/_shared/lib/__tests__/monacoLineEndings.test.ts
// PURPOSE: Lock the guarantee that every Monaco model in this app is LF.
// CONTEXT: The defect this prevents is invisible on screen and only shows up as
//          a string comparison failing between a buffer and a store, so a test
//          that reads the EOL directly is the only place it is legible. See the
//          module header for the full account.

import { describe, it, expect } from "vitest";
import {
  STORED_TEXT_EOL,
  enforceLfLineEndings,
  toStoredTextEol,
  type MonacoEolNamespace,
} from "../monacoLineEndings";

/** A Monaco double small enough to read, faithful where it matters. */
function fakeMonaco() {
  const LF = 1;
  const CRLF = 2;
  const models: Array<{ eol: number; setEOL(e: number): void }> = [];
  let listener: ((m: { setEOL(e: number): void }) => void) | null = null;
  let listenerCount = 0;

  const makeModel = (initialEol: number) => {
    const model = {
      eol: initialEol,
      setEOL(e: number) {
        this.eol = e;
      },
    };
    models.push(model);
    listener?.(model);
    return model;
  };

  const monaco: MonacoEolNamespace = {
    editor: {
      EndOfLineSequence: { LF },
      getModels: () => models,
      onDidCreateModel: (l) => {
        listener = l as typeof listener;
        listenerCount += 1;
        return { dispose: () => { listener = null; } };
      },
    },
  };

  return { monaco, makeModel, models, LF, CRLF, listeners: () => listenerCount };
}

describe("enforceLfLineEndings", () => {
  it("puts every model created afterwards on LF", () => {
    const f = fakeMonaco();
    enforceLfLineEndings(f.monaco);

    // The case that actually bites: @monaco-editor/react creates the model from
    // the EMPTY string while the document is still loading, so Monaco falls back
    // to the platform default — CRLF on Windows.
    const born = f.makeModel(f.CRLF);
    expect(born.eol).toBe(f.LF);
  });

  it("brings models that already existed into line", () => {
    const f = fakeMonaco();
    const early = f.makeModel(f.CRLF);
    expect(early.eol).toBe(f.CRLF);

    enforceLfLineEndings(f.monaco);
    expect(early.eol).toBe(f.LF);
  });

  it("is idempotent per realm — one subscription, not one per call", () => {
    const f = fakeMonaco();
    enforceLfLineEndings(f.monaco);
    enforceLfLineEndings(f.monaco);
    enforceLfLineEndings(f.monaco);
    expect(f.listeners()).toBe(1);
  });

  it("hooks each realm separately — a second editor window needs its own", () => {
    const a = fakeMonaco();
    const b = fakeMonaco();
    enforceLfLineEndings(a.monaco);
    enforceLfLineEndings(b.monaco);
    expect(a.listeners()).toBe(1);
    expect(b.listeners()).toBe(1);
    expect(b.makeModel(b.CRLF).eol).toBe(b.LF);
  });
});

describe("toStoredTextEol", () => {
  it("normalises CRLF and bare CR to the stored ending", () => {
    expect(toStoredTextEol("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves already-normalised text byte-identical", () => {
    const text = "// Macro\nfunction f() {\n\n  return 1;\n}\n";
    expect(toStoredTextEol(text)).toBe(text);
  });

  it("turns the exact shape of the macro-live-edit failure back into the source", () => {
    // Every line differs by an invisible trailing run and the one blank line
    // comes back non-empty — that is a CRLF copy and nothing else.
    const source = "// Macro\nasync function f(api) {\n}\n\nfunction setup() {\n}\n";
    const asMonacoStoredIt = source.replace(/\n/g, "\r\n");
    expect(asMonacoStoredIt).not.toBe(source);
    expect(asMonacoStoredIt.split("\n").length).toBe(source.split("\n").length);
    expect(toStoredTextEol(asMonacoStoredIt)).toBe(source);
  });

  it("STORED_TEXT_EOL is LF, not the platform's ending", () => {
    expect(STORED_TEXT_EOL).toBe("\n");
  });
});
