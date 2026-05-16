//! FILENAME: app/extensions/Controls/lib/__tests__/floatingStore-state-machine.test.ts
// PURPOSE: State machine tests for the floating controls store.
// CONTEXT: Models control lifecycle, z-order, and group state machines.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@api/gridOverlays', () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
}));

vi.mock('../../lib/designMode', () => ({
  getDesignMode: vi.fn(() => false),
}));

import {
  addFloatingControl,
  removeFloatingControl,
  getFloatingControl,
  getAllFloatingControls,
  moveFloatingControl,
  resizeFloatingControl,
  resetFloatingStore,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  groupControls,
  ungroupControls,
  getGroupForControl,
  getGroupMembers,
  getGroupBounds,
  moveGroupControls,
  getAllGroups,
  type FloatingControl,
} from '../../lib/floatingStore';

function makeCtrl(id: string, x = 0, y = 0, w = 100, h = 50): FloatingControl {
  return {
    id,
    sheetIndex: 0,
    row: 0,
    col: 0,
    x,
    y,
    width: w,
    height: h,
    controlType: 'button',
  };
}

describe('Floating Store - Control Lifecycle State Machine', () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  // ============================================================================
  // Lifecycle: add -> visible -> selected -> moved/resized -> deleted
  // ============================================================================

  it('starts with no controls', () => {
    expect(getAllFloatingControls()).toEqual([]);
  });

  it('add: control becomes visible in the store', () => {
    addFloatingControl(makeCtrl('c1'));
    expect(getFloatingControl('c1')).not.toBeNull();
    expect(getAllFloatingControls().length).toBe(1);
  });

  it('add -> move: position updates', () => {
    addFloatingControl(makeCtrl('c1', 10, 20));
    moveFloatingControl('c1', 50, 60);
    const ctrl = getFloatingControl('c1')!;
    expect(ctrl.x).toBe(50);
    expect(ctrl.y).toBe(60);
  });

  it('add -> resize: dimensions update', () => {
    addFloatingControl(makeCtrl('c1', 10, 20, 100, 50));
    resizeFloatingControl('c1', 15, 25, 200, 80);
    const ctrl = getFloatingControl('c1')!;
    expect(ctrl.x).toBe(15);
    expect(ctrl.y).toBe(25);
    expect(ctrl.width).toBe(200);
    expect(ctrl.height).toBe(80);
  });

  it('add -> delete: control is removed', () => {
    addFloatingControl(makeCtrl('c1'));
    removeFloatingControl('c1');
    expect(getFloatingControl('c1')).toBeNull();
    expect(getAllFloatingControls().length).toBe(0);
  });

  it('add -> move -> resize -> delete: full lifecycle', () => {
    addFloatingControl(makeCtrl('c1', 0, 0, 100, 50));
    moveFloatingControl('c1', 30, 40);
    resizeFloatingControl('c1', 30, 40, 150, 75);
    expect(getFloatingControl('c1')!.width).toBe(150);
    removeFloatingControl('c1');
    expect(getFloatingControl('c1')).toBeNull();
  });

  it('move on non-existent control is a no-op', () => {
    moveFloatingControl('nonexistent', 10, 20);
    expect(getAllFloatingControls().length).toBe(0);
  });

  it('resize on non-existent control is a no-op', () => {
    resizeFloatingControl('nonexistent', 0, 0, 50, 50);
    expect(getAllFloatingControls().length).toBe(0);
  });

  it('add duplicate ID replaces existing control', () => {
    addFloatingControl(makeCtrl('c1', 0, 0, 100, 50));
    addFloatingControl(makeCtrl('c1', 10, 10, 200, 100));
    expect(getAllFloatingControls().length).toBe(1);
    expect(getFloatingControl('c1')!.width).toBe(200);
  });
});

describe('Floating Store - Z-Order State Machine', () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  function getOrder(): string[] {
    return getAllFloatingControls().map((c) => c.id);
  }

  it('controls are ordered by insertion order', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    expect(getOrder()).toEqual(['a', 'b', 'c']);
  });

  it('bringToFront moves control to end', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    bringToFront('a');
    expect(getOrder()).toEqual(['b', 'c', 'a']);
  });

  it('sendToBack moves control to beginning', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    sendToBack('c');
    expect(getOrder()).toEqual(['c', 'a', 'b']);
  });

  it('bringForward moves one step up', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    bringForward('a');
    expect(getOrder()).toEqual(['b', 'a', 'c']);
  });

  it('sendBackward moves one step down', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    sendBackward('c');
    expect(getOrder()).toEqual(['a', 'c', 'b']);
  });

  it('bringToFront on last element is a no-op (order preserved)', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    bringToFront('b');
    expect(getOrder()).toEqual(['a', 'b']);
  });

  it('sendToBack on first element is a no-op', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    sendToBack('a');
    expect(getOrder()).toEqual(['a', 'b']);
  });

  it('z-order monotonic: repeated bringToFront always results in last position', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    bringToFront('a');
    bringToFront('b');
    bringToFront('a');
    // a should be last
    const order = getOrder();
    expect(order[order.length - 1]).toBe('a');
  });

  it('z-order preserved through group operations', () => {
    addFloatingControl(makeCtrl('a'));
    addFloatingControl(makeCtrl('b'));
    addFloatingControl(makeCtrl('c'));
    addFloatingControl(makeCtrl('d'));

    // Group b and c
    groupControls(['b', 'c']);
    // bringToFront on a grouped member moves the entire group
    bringToFront('b');
    const order = getOrder();
    // b and c should be at the end (as a group)
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'));
    expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('a'));
  });
});

describe('Floating Store - Group State Machine', () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  // States: ungrouped -> grouped -> ungrouped (dissolved)

  it('controls start ungrouped', () => {
    addFloatingControl(makeCtrl('c1'));
    expect(getGroupForControl('c1')).toBeNull();
  });

  it('ungrouped -> grouped: groupControls creates a group', () => {
    addFloatingControl(makeCtrl('c1'));
    addFloatingControl(makeCtrl('c2'));
    const gid = groupControls(['c1', 'c2']);
    expect(getGroupForControl('c1')).toBe(gid);
    expect(getGroupForControl('c2')).toBe(gid);
    expect(getGroupMembers(gid).sort()).toEqual(['c1', 'c2']);
  });

  it('grouped -> ungrouped: ungroupControls dissolves', () => {
    addFloatingControl(makeCtrl('c1'));
    addFloatingControl(makeCtrl('c2'));
    const gid = groupControls(['c1', 'c2']);
    ungroupControls(gid);
    expect(getGroupForControl('c1')).toBeNull();
    expect(getGroupForControl('c2')).toBeNull();
    expect(getAllGroups().length).toBe(0);
  });

  it('cannot group fewer than 2 controls', () => {
    addFloatingControl(makeCtrl('c1'));
    expect(() => groupControls(['c1'])).toThrow('Cannot group fewer than 2');
  });

  it('member-removed -> auto-dissolved: removing a member below 2 dissolves group', () => {
    addFloatingControl(makeCtrl('c1'));
    addFloatingControl(makeCtrl('c2'));
    const gid = groupControls(['c1', 'c2']);

    // Remove one member via removeFloatingControl
    removeFloatingControl('c1');

    // Group should be auto-dissolved
    expect(getGroupForControl('c2')).toBeNull();
    expect(getAllGroups().length).toBe(0);
  });

  it('removing a non-last member from a 3-member group keeps the group', () => {
    addFloatingControl(makeCtrl('c1'));
    addFloatingControl(makeCtrl('c2'));
    addFloatingControl(makeCtrl('c3'));
    const gid = groupControls(['c1', 'c2', 'c3']);

    removeFloatingControl('c1');

    // Group should still exist with 2 members
    expect(getGroupForControl('c2')).toBe(gid);
    expect(getGroupForControl('c3')).toBe(gid);
    expect(getGroupMembers(gid).sort()).toEqual(['c2', 'c3']);
  });

  it('regrouping: control moved from one group to another', () => {
    addFloatingControl(makeCtrl('c1'));
    addFloatingControl(makeCtrl('c2'));
    addFloatingControl(makeCtrl('c3'));
    addFloatingControl(makeCtrl('c4'));

    const g1 = groupControls(['c1', 'c2']);
    const g2 = groupControls(['c3', 'c4']);

    // Now group c2 with c3 - should remove c2 from g1 and c3 from g2
    const g3 = groupControls(['c2', 'c3']);

    // g1 should be dissolved (only c1 left)
    expect(getGroupForControl('c1')).toBeNull();
    // g2 should be dissolved (only c4 left)
    expect(getGroupForControl('c4')).toBeNull();
    // c2 and c3 should be in g3
    expect(getGroupForControl('c2')).toBe(g3);
    expect(getGroupForControl('c3')).toBe(g3);
  });

  it('group bounds reflect member positions', () => {
    addFloatingControl(makeCtrl('c1', 10, 20, 50, 30));
    addFloatingControl(makeCtrl('c2', 100, 200, 50, 30));
    const gid = groupControls(['c1', 'c2']);

    const bounds = getGroupBounds(gid)!;
    expect(bounds.x).toBe(10);
    expect(bounds.y).toBe(20);
    expect(bounds.width).toBe(140); // 100+50 - 10
    expect(bounds.height).toBe(210); // 200+30 - 20
  });

  it('moveGroupControls moves all members', () => {
    addFloatingControl(makeCtrl('c1', 10, 20));
    addFloatingControl(makeCtrl('c2', 50, 60));
    const gid = groupControls(['c1', 'c2']);

    moveGroupControls(gid, 5, 10);
    expect(getFloatingControl('c1')!.x).toBe(15);
    expect(getFloatingControl('c1')!.y).toBe(30);
    expect(getFloatingControl('c2')!.x).toBe(55);
    expect(getFloatingControl('c2')!.y).toBe(70);
  });

  it('resetFloatingStore clears all controls and groups', () => {
    addFloatingControl(makeCtrl('c1'));
    addFloatingControl(makeCtrl('c2'));
    groupControls(['c1', 'c2']);

    resetFloatingStore();
    expect(getAllFloatingControls().length).toBe(0);
    expect(getAllGroups().length).toBe(0);
  });

  it('full group lifecycle: create -> group -> move -> remove member -> auto-dissolve -> regroup', () => {
    addFloatingControl(makeCtrl('a', 0, 0));
    addFloatingControl(makeCtrl('b', 50, 0));
    addFloatingControl(makeCtrl('c', 100, 0));

    // Group a+b
    const g1 = groupControls(['a', 'b']);
    expect(getAllGroups().length).toBe(1);

    // Move group
    moveGroupControls(g1, 10, 10);
    expect(getFloatingControl('a')!.x).toBe(10);
    expect(getFloatingControl('b')!.x).toBe(60);

    // Remove b -> group auto-dissolves
    removeFloatingControl('b');
    expect(getAllGroups().length).toBe(0);
    expect(getGroupForControl('a')).toBeNull();

    // Regroup a+c
    const g2 = groupControls(['a', 'c']);
    expect(getGroupForControl('a')).toBe(g2);
    expect(getGroupForControl('c')).toBe(g2);
  });
});
