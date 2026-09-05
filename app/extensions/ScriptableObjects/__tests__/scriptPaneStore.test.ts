//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptPaneStore.test.ts
// PURPOSE: The headless half of the script task-pane renderer (M2 S4): the
//          per-pane store the section component subscribes to, and the ONE
//          patch-landing body it shares with the modal form (`landFormPatch`).
// CONTEXT: The property worth the most is that a script patch never ECHOES —
//          nothing leaves the store when the host lands values, so a script
//          that updates its own pane cannot receive its own update back as a
//          "change" and loop. And a pane has no terminal events: the only
//          things that ever leave are change / click / visible / hidden / close.

import { describe, it, expect } from "vitest";
import type { FormSeed, FormSpec } from "@api/scriptHost/scriptFormSpec";
import type { ScriptPaneInputPayload, ScriptPaneRequestPayload } from "@api/scriptHost/scriptPaneSpec";
import { collectInputs, landFormPatch, type FormInputWidget } from "../lib/scriptFormState";
import { createScriptPaneStore } from "../lib/scriptPaneStore";

const SPEC: FormSpec = {
  title: "Status",
  children: [
    { type: "textbox", name: "note", label: "Note" },
    { type: "number", name: "amount", label: "Amount" },
    { type: "checkbox", name: "done", label: "Done" },
    { type: "listbox", name: "tags", label: "Tags", options: ["a", "b"], multi: true },
    { type: "button", name: "refresh", text: "Refresh" },
  ],
};

function request(seeds: Record<string, FormSeed> = {}): ScriptPaneRequestPayload {
  return {
    paneId: "pane-1",
    scriptId: "script-1",
    scriptName: "Status board",
    origin: { kind: "local" },
    spec: SPEC,
    seeds,
  };
}

function inputsOf(spec: FormSpec): Map<string, FormInputWidget> {
  const m = new Map<string, FormInputWidget>();
  for (const { widget } of collectInputs(spec)) m.set(widget.name, widget);
  return m;
}

function harness(seeds?: Record<string, FormSeed>) {
  const out: ScriptPaneInputPayload[] = [];
  const store = createScriptPaneStore(request(seeds), (p) => out.push(p));
  return { store, out, kinds: () => out.map((p) => p.kind) };
}

// ----------------------------------------------------------------------------
// landFormPatch — the shared body
// ----------------------------------------------------------------------------

describe("landFormPatch", () => {
  const inputs = inputsOf(SPEC);
  const base = () => ({
    values: { note: "", amount: null, done: false, tags: [] as string[] },
    controls: {},
    seeds: {} as Record<string, FormSeed>,
    stale: new Set<string>(),
  });

  it("coerces a script's patched values to the widget's type", () => {
    const landed = landFormPatch(base(), { patch: { values: { amount: "12", done: "TRUE", tags: "a" } } }, inputs, new Set());
    expect(landed.values.amount).toBe(12);
    expect(landed.values.done).toBe(true);
    expect(landed.values.tags).toEqual(["a"]);
    expect(landed.patchedNames).toEqual(["amount", "done", "tags"]);
  });

  it("keeps identity where nothing landed, so a caller can compare references", () => {
    const state = base();
    const landed = landFormPatch(state, { patch: { controls: { note: { label: "Renamed" } } } }, inputs, new Set());
    expect(landed.values).toBe(state.values);
    expect(landed.seeds).toBe(state.seeds);
    expect(landed.stale).toBe(state.stale);
    expect(landed.controls).not.toBe(state.controls);
    expect(landed.controls.note).toEqual({ label: "Renamed" });
    expect(landed.patchedNames).toEqual([]);
  });

  it("lands a refreshed seed on an untouched widget, and keeps a touched one's value as stale", () => {
    const state = { ...base(), values: { note: "mine", amount: 5, done: false, tags: [] as string[] } };
    const landed = landFormPatch(
      state,
      { seeds: { note: { value: "theirs" }, amount: { value: 99 } } },
      inputs,
      new Set(["note"]),
    );
    expect(landed.values.note).toBe("mine");
    expect(landed.stale.has("note")).toBe(true);
    expect(landed.values.amount).toBe(99);
    expect(landed.stale.has("amount")).toBe(false);
    expect(landed.seeds.note).toEqual({ value: "theirs" });
  });

  it("a touched widget edited BACK to its previous seed counts as untouched", () => {
    const state = {
      ...base(),
      values: { note: "old", amount: null, done: false, tags: [] as string[] },
      seeds: { note: { value: "old" } } as Record<string, FormSeed>,
    };
    const landed = landFormPatch(state, { seeds: { note: { value: "new" } } }, inputs, new Set(["note"]));
    expect(landed.values.note).toBe("new");
    expect(landed.stale.has("note")).toBe(false);
  });

  it("never mutates its input", () => {
    const state = base();
    const valuesBefore = { ...state.values };
    landFormPatch(state, { patch: { values: { note: "x" } }, seeds: { amount: { value: 1 } } }, inputs, new Set());
    expect(state.values).toEqual(valuesBefore);
    expect(state.seeds).toEqual({});
    expect(state.stale.size).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// The store
// ----------------------------------------------------------------------------

describe("createScriptPaneStore", () => {
  it("starts from the seeds, then the declared defaults", () => {
    const { store } = harness({ amount: { value: 1234.5, display: "£1,234.50" } });
    expect(store.getSnapshot().values).toEqual({ note: "", amount: 1234.5, done: false, tags: [] });
    expect(store.getSnapshot().seeds.amount).toEqual({ value: 1234.5, display: "£1,234.50" });
  });

  it("a user change touches the widget, keeps the value and leaves as 'change' with every value", () => {
    const { store, out } = harness();
    store.change("note", "hello");
    expect(store.getSnapshot().values.note).toBe("hello");
    expect(out).toEqual([
      { paneId: "pane-1", kind: "change", name: "note", value: "hello", values: { note: "hello", amount: null, done: false, tags: [] } },
    ]);
  });

  it("a script patch lands and ECHOES NOTHING", () => {
    const { store, out } = harness();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.applyPatch({
      patch: {
        values: { amount: "7" },
        controls: { note: { label: "Renamed" } },
        message: { text: "Saved", kind: "info" },
        focus: "note",
      },
    });
    const snap = store.getSnapshot();
    expect(snap.values.amount).toBe(7);
    expect(snap.controls.note).toEqual({ label: "Renamed" });
    expect(snap.message).toEqual({ text: "Saved", kind: "info" });
    expect(snap.focusRequest).toEqual({ name: "note", seq: 1 });
    expect(notified).toBe(1);
    expect(out).toEqual([]);
  });

  it("the same focus name twice is two requests (seq rises)", () => {
    const { store } = harness();
    store.applyPatch({ patch: { focus: "note" } });
    store.applyPatch({ patch: { focus: "note" } });
    expect(store.getSnapshot().focusRequest).toEqual({ name: "note", seq: 2 });
  });

  it("refreshed seeds respect what the USER typed, and a later edit clears the stale mark", () => {
    const { store } = harness();
    store.change("note", "mine");
    store.applyPatch({ seeds: { note: { value: "theirs" }, amount: { value: 3 } } });
    expect(store.getSnapshot().values.note).toBe("mine");
    expect(store.getSnapshot().stale.has("note")).toBe(true);
    expect(store.getSnapshot().values.amount).toBe(3);
    store.change("note", "mine again");
    expect(store.getSnapshot().stale.has("note")).toBe(false);
  });

  it("click / visible / hidden leave by kind; close leaves ONCE", () => {
    const { store, out, kinds } = harness();
    store.mounted();
    store.click("refresh");
    store.unmounted();
    store.close();
    store.close();
    expect(kinds()).toEqual(["visible", "click", "hidden", "close"]);
    expect(out[1].name).toBe("refresh");
    expect(out.every((p) => p.paneId === "pane-1")).toBe(true);
  });

  it("nothing leaves and nothing lands after the host disposed it", () => {
    const { store, out } = harness();
    store.dispose();
    expect(store.isClosed()).toBe(true);
    store.change("note", "late");
    store.click("refresh");
    store.mounted();
    store.close();
    store.applyPatch({ patch: { values: { note: "late" } } });
    expect(out).toEqual([]);
    expect(store.getSnapshot().values.note).toBe("");
  });

  it("the snapshot is referentially stable between changes (useSyncExternalStore contract)", () => {
    const { store } = harness();
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    store.change("note", "x");
    expect(store.getSnapshot()).not.toBe(a);
  });

  it("the HOST banner has its own slot (S6): a script patch can neither clear nor overwrite it, and it echoes nothing", () => {
    // The throttle notice is the sentence that says what the script is doing
    // to its pane; a script that could patch it away would have the last word.
    const { store, out } = harness();
    store.setHostBanner({ text: "Slowed down.", kind: "warning" });
    expect(store.getSnapshot().hostBanner).toEqual({ text: "Slowed down.", kind: "warning" });
    store.applyPatch({ patch: { message: null } });
    store.applyPatch({ patch: { message: { text: "All good", kind: "info" }, values: { note: "x" } } });
    expect(store.getSnapshot().hostBanner).toEqual({ text: "Slowed down.", kind: "warning" });
    expect(store.getSnapshot().message).toEqual({ text: "All good", kind: "info" });
    expect(store.getSnapshot().values.note).toBe("x");
    // Only the host's own door clears it.
    store.setHostBanner(null);
    expect(store.getSnapshot().hostBanner).toBeNull();
    expect(out).toEqual([]);
    // And after the host disposed the pane, nothing lands there either.
    store.dispose();
    store.setHostBanner({ text: "late", kind: "error" });
    expect(store.getSnapshot().hostBanner).toBeNull();
  });

  it("the BINDINGS notice is a third slot: the script's message survives its clear, and the throttle banner does not take it down", () => {
    // Both host notices can be true at once — a script slowed down while the
    // user is on another sheet — and neither is the script's to write.
    const { store, out } = harness();
    const offSheet = { text: 'switch back to "Sheet1" to see and save this pane\'s cells', kind: "warning" as const };
    store.setHostBindingNotice(offSheet);
    store.applyPatch({ patch: { message: { text: "Ready", kind: "info" } } });
    expect(store.getSnapshot().hostBindingNotice).toEqual(offSheet);
    expect(store.getSnapshot().message).toEqual({ text: "Ready", kind: "info" });
    // A throttle banner arrives while the notice is up: two slots, both shown.
    store.setHostBanner({ text: "Slowed down.", kind: "warning" });
    expect(store.getSnapshot().hostBindingNotice).toEqual(offSheet);
    // ...and the cooldown lifting clears only the banner.
    store.setHostBanner(null);
    expect(store.getSnapshot().hostBindingNotice).toEqual(offSheet);
    // The user returns to the pinned sheet: the host clears its own slot and
    // the script's message is exactly where the script left it.
    store.setHostBindingNotice(null);
    expect(store.getSnapshot().hostBindingNotice).toBeNull();
    expect(store.getSnapshot().message).toEqual({ text: "Ready", kind: "info" });
    // A clear that changes nothing publishes nothing (the host clears on every
    // reveal on the pinned sheet), and none of this echoes to the host.
    const steady = store.getSnapshot();
    store.setHostBindingNotice(null);
    expect(store.getSnapshot()).toBe(steady);
    expect(out).toEqual([]);
  });
});
