//! FILENAME: app/src/api/__tests__/api-constants-snapshot.test.ts
// PURPOSE: Snapshot tests to catch accidental changes to public API constants.

import { describe, it, expect } from 'vitest';
import { AppEvents } from '../events';
import { CoreCommands } from '../commands';

// ============================================================================
// AppEvents snapshot
// ============================================================================

describe('AppEvents', () => {
  it('all event values match snapshot', () => {
    expect(AppEvents).toMatchSnapshot();
  });

  it('event count stays stable', () => {
    // 59 since TABLE_CREATED / TABLE_DEFINITIONS_UPDATED were promoted to @api
    // so the Table extension could stop re-declaring them locally.
    expect(Object.keys(AppEvents).length).toMatchInlineSnapshot(`59`);
  });

  it('all values use the app: prefix', () => {
    for (const [key, value] of Object.entries(AppEvents)) {
      expect(value).toMatch(/^app:/);
    }
  });
});

// ============================================================================
// CoreCommands snapshot
// ============================================================================

describe('CoreCommands', () => {
  it('all command values match snapshot', () => {
    expect(CoreCommands).toMatchSnapshot();
  });

  it('command count stays stable', () => {
    expect(Object.keys(CoreCommands).length).toMatchInlineSnapshot(`33`);
  });

  it('all values use the core. prefix', () => {
    for (const [key, value] of Object.entries(CoreCommands)) {
      expect(value).toMatch(/^core\./);
    }
  });
});
