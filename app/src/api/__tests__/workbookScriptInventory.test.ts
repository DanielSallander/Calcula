//! FILENAME: app/src/api/__tests__/workbookScriptInventory.test.ts
// PURPOSE: `listWorkbookScriptRecords` must not LOSE provenance it was already
//          told.
// CONTEXT: `list_scripts` copies `source_package` verbatim onto every row
//          (`script_summary`, app/src-tauri/src/scripting/commands.rs), so the
//          listing is an independent authority on whose module each entry is.
//          The inventory then fans out to `get_script` for the full record — and
//          when one of those reads failed it wrote `sourcePackage: null`,
//          throwing away an answer the listing had already given and that had
//          NOT failed.
//
//          The consequence is not cosmetic. Every consumer of these records
//          reads provenance off them — the editor's "from application X" badge,
//          the macro library's fork-vs-save decision, the code inventory — so a
//          transient read error silently re-described a publisher's module as
//          the user's own code, at the source. Downstream surfaces were taught
//          to carry the last known answer forward; the list should not have
//          dropped it in the first place.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface Row {
  id: string;
  name: string;
  sourcePackage?: string;
}
interface StoredRecord {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage?: string | null;
}

/** What `list_scripts` returns. */
const rows: Row[] = [];
/** What `get_script` returns, by id. Missing => the read FAILS. */
const records = new Map<string, StoredRecord>();
/** Ids whose `get_script` fails with this message. */
const readFailures = new Map<string, string>();

const invokeBackend = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  if (cmd === "list_scripts") return rows;
  if (cmd === "get_script") {
    const id = (args as { id: string }).id;
    const failure = readFailures.get(id);
    if (failure) throw new Error(failure);
    const found = records.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  }
  throw new Error(`unexpected backend command: ${cmd}`);
});

vi.mock("../backend", () => ({
  invokeBackend: (cmd: string, args?: unknown) => invokeBackend(cmd, args),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => null,
}));

vi.mock("../dialogs", () => ({
  confirmAsync: vi.fn().mockResolvedValue(false),
}));

import {
  listDistributedWorkbookScriptRecords,
  listWorkbookScriptRecords,
} from "../workbookScripts";

beforeEach(() => {
  rows.length = 0;
  records.clear();
  readFailures.clear();
  invokeBackend.mockClear();
});

/** The ids `get_script` was asked for, in order. */
function fetchedIds(): string[] {
  return invokeBackend.mock.calls
    .filter(([cmd]) => cmd === "get_script")
    .map(([, args]) => (args as { id: string }).id);
}

/** A stored record whose body is readable. */
function storeReadable(id: string, sourcePackage: string | null): void {
  records.set(id, {
    id,
    name: `${id} (name)`,
    description: null,
    source: `// body of ${id}`,
    sourcePackage,
  });
}

// ===========================================================================
// The distributed-only door: N local + M distributed costs M fetches, not N+M
// ===========================================================================
//
// The object-script consent load path runs on every workbook open and every
// `.calp` update, and it listed the WHOLE store through the full inventory —
// one `get_script` per module, the user's own recorded macros included, to hash
// the distributed ones and discard the rest. The summary row already says which
// rows are distributed; the door below fetches only those.

describe("listDistributedWorkbookScriptRecords — fetches source for distributed rows only", () => {
  it("N local + M distributed costs M `get_script` calls, and lists exactly those M", async () => {
    // N = 3 local, M = 2 distributed, interleaved so a prefix/suffix filter
    // would not pass by accident.
    rows.push({ id: "l1", name: "Mine 1" });
    rows.push({ id: "d1", name: "Theirs 1", sourcePackage: "Acme Finance Pack" });
    rows.push({ id: "l2", name: "Mine 2" });
    rows.push({ id: "l3", name: "Mine 3" });
    rows.push({ id: "d2", name: "Theirs 2", sourcePackage: "Beta Reports" });
    for (const id of ["l1", "l2", "l3"]) storeReadable(id, null);
    storeReadable("d1", "Acme Finance Pack");
    storeReadable("d2", "Beta Reports");

    const listed = await listDistributedWorkbookScriptRecords();

    expect(
      fetchedIds(),
      "the consent load path must not pay one round trip per LOCAL module to answer a " +
        "question about the distributed ones",
    ).toEqual(["d1", "d2"]);
    expect(invokeBackend.mock.calls.filter(([cmd]) => cmd === "list_scripts")).toHaveLength(1);
    expect(listed.map((r) => r.id)).toEqual(["d1", "d2"]);
    expect(listed.map((r) => r.source)).toEqual(["// body of d1", "// body of d2"]);
    expect(listed.every((r) => r.loadError === null)).toBe(true);
  });

  it("decides 'distributed' the way the gates do: any present stamp, even a blank one", async () => {
    // `scriptOriginForStoredRecord` reads a present stamp as a package (Rust
    // reads the same `Option<String>` and holds any `Some(..)` to be a
    // publisher's). A door that re-derived the split with `if (sourcePackage)`
    // would silently drop a blank-stamped module from the consent listing.
    rows.push({ id: "blank", name: "Blank stamp", sourcePackage: "   " });
    rows.push({ id: "mine", name: "Mine" });
    storeReadable("blank", "   ");
    storeReadable("mine", null);

    const listed = await listDistributedWorkbookScriptRecords();

    expect(fetchedIds()).toEqual(["blank"]);
    expect(listed.map((r) => r.id)).toEqual(["blank"]);
  });

  it("a distributed record that fails to read is still listed, provenance kept", async () => {
    // The consent recorder must SEE that the application ships this module —
    // it refuses to hash an unreadable one — rather than be told the
    // application ships one macro fewer.
    rows.push({ id: "d1", name: "Theirs 1", sourcePackage: "Acme Finance Pack" });
    rows.push({ id: "l1", name: "Mine 1" });
    readFailures.set("d1", "record checksum mismatch");
    storeReadable("l1", null);

    const listed = await listDistributedWorkbookScriptRecords();

    expect(fetchedIds()).toEqual(["d1"]);
    expect(listed).toHaveLength(1);
    expect(listed[0].sourcePackage).toBe("Acme Finance Pack");
    expect(listed[0].loadError).toMatch(/checksum mismatch/);
    expect(listed[0].source).toBe("");
  });

  it("the full inventory still fetches every record (the positive control)", async () => {
    rows.push({ id: "l1", name: "Mine 1" });
    rows.push({ id: "d1", name: "Theirs 1", sourcePackage: "Acme Finance Pack" });
    storeReadable("l1", null);
    storeReadable("d1", "Acme Finance Pack");

    await listWorkbookScriptRecords();

    expect(fetchedIds()).toEqual(["l1", "d1"]);
  });
});

describe("listWorkbookScriptRecords — a read failure must not erase provenance", () => {
  it("uses the RECORD's own source package when the record loads", async () => {
    rows.push({ id: "m1", name: "Vendor close", sourcePackage: "Acme Finance Pack" });
    records.set("m1", {
      id: "m1",
      name: "Vendor close",
      description: null,
      source: "function setup(c){}",
      sourcePackage: "Acme Finance Pack",
    });

    const [record] = await listWorkbookScriptRecords();
    expect(record.sourcePackage).toBe("Acme Finance Pack");
    expect(record.loadError).toBeNull();
  });

  it("KEEPS the summary's source package when the record read fails", async () => {
    // The listing said "Acme Finance Pack" and the listing did not fail. A
    // failure to read the BODY is not evidence about the provenance.
    rows.push({ id: "m1", name: "Vendor close", sourcePackage: "Acme Finance Pack" });
    readFailures.set("m1", "record checksum mismatch");

    const [record] = await listWorkbookScriptRecords();

    expect(record.sourcePackage).toBe("Acme Finance Pack");
    // ...and the failure still travels WITH the entry: the module stays visible,
    // and nothing pretends it holds source it could not read.
    expect(record.loadError).toMatch(/checksum mismatch/);
    expect(record.source).toBe("");
  });

  it("invents nothing for a LOCAL module whose record fails to load", async () => {
    // The other direction is just as wrong: a listing with no package is the
    // answer "this is the user's own", and a failed body read must not turn it
    // into a package either.
    rows.push({ id: "m2", name: "Monthly close" });
    readFailures.set("m2", "disk read error");

    const [record] = await listWorkbookScriptRecords();

    expect(record.sourcePackage).toBeNull();
    expect(record.loadError).toMatch(/disk read error/);
  });

  it("one unreadable module does not make the others invisible", async () => {
    rows.push({ id: "bad", name: "Broken", sourcePackage: "Acme Finance Pack" });
    rows.push({ id: "good", name: "Fine" });
    readFailures.set("bad", "boom");
    records.set("good", {
      id: "good",
      name: "Fine",
      description: null,
      source: "function setup(c){}",
      sourcePackage: null,
    });

    const listed = await listWorkbookScriptRecords();

    expect(listed.map((r) => r.id)).toEqual(["bad", "good"]);
    expect(listed[0].sourcePackage).toBe("Acme Finance Pack");
    expect(listed[1].sourcePackage).toBeNull();
  });
});
