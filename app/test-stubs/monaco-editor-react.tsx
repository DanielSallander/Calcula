//! FILENAME: app/test-stubs/monaco-editor-react.tsx
// PURPOSE: Test stub for "@monaco-editor/react" under vitest/jsdom.
// CONTEXT: Renders nothing; loader is a no-op. See test-stubs/monaco-editor.ts.

export default function Editor(): null {
  return null;
}

export function DiffEditor(): null {
  return null;
}

export const loader = {
  config: (): void => {},
  init: (): Promise<unknown> => Promise.resolve({}),
};

export function useMonaco(): null {
  return null;
}
