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
    // 64 since B5 added the sheet-collection events (SHEET_ADDED /
    // SHEET_DELETED / SHEET_RENAMED), RECALCULATION_COMPLETED, and
    // PACKAGE_UPDATED — the last of which replaced the untyped, script-invisible
    // "calp:scripts-pulled" window event.
    //
    // 65 since G4 added WRITEBACK_SUBMISSION_RECEIVED: until now a .calp
    // publisher could learn that answers had arrived ONLY by opening the
    // Responses pane and looking, and a script could not learn it at all. The
    // count is bumped deliberately, and the event is a real one — it is raised
    // by the demand-driven publisher-inbox poll in @api/distribution.ts, which
    // exists precisely so this id is not a promise nothing keeps.
    expect(Object.keys(AppEvents).length).toMatchInlineSnapshot(`65`);
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
