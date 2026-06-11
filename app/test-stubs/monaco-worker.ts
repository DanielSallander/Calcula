//! FILENAME: app/test-stubs/monaco-worker.ts
// PURPOSE: Test stub for monaco "?worker" imports under vitest/jsdom.

export default class StubWorker {
  onmessage: ((ev: unknown) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
