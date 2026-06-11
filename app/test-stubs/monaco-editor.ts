//! FILENAME: app/test-stubs/monaco-editor.ts
// PURPOSE: Test stub for "monaco-editor" under vitest/jsdom.
// CONTEXT: Real monaco crashes jsdom (legacy clipboard API) and takes seconds
//          to evaluate. No unit test exercises real editor behavior, so every
//          accessed member resolves to a permissive self-returning proxy.

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeAnything(): any {
  const target = function () {} as any;
  const proxy: any = new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined; // never look like a thenable
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

const anything = makeAnything();

export const editor = anything;
export const languages = anything;
export const KeyMod = anything;
export const KeyCode = anything;
export const Range = anything;
export const Selection = anything;
export const Position = anything;
export const Uri = anything;
export const MarkerSeverity = anything;
export const MarkerTag = anything;
export const CancellationTokenSource = anything;
export const Emitter = anything;
export default anything;
