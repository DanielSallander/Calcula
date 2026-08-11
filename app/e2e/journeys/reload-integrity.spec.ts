/**
 * §2ab / §2ag / §3bi PROVED ON THE RUNNING APP — what survives a save and a
 * reopen, what an operation refuses to do, and what a real `.xlsx` carries.
 *
 * WHY THIS FILE EXISTS. The three passes this covers all closed with the same
 * sentence: "proved in-process, the live projects were not re-run". Every claim
 * below was therefore reproduced through the REAL backend on a cold `tauri dev`
 * build, against files really written to and read from disk.
 *
 * WHAT IS ASSERTED, and where each claim comes from:
 *
 *   1. §2ab (register §3be) — a `.cala` persists a dynamic array's EXTENT, not
 *      just its values. A reopened array is therefore OWNED: editing its input
 *      does not kill it; SHRINKING it leaves no stale literal underneath; and
 *      one of its cells cannot be typed into. Before §3be the reopened array
 *      collapsed to `#VALUE!` on the first edit of its input, and a shrink left
 *      the cells it no longer covers sitting under a live origin, presented as
 *      its output.
 *
 *   2. §3be's legacy half — a workbook written by the PRE-CHANGE build (no `sp`,
 *      `formatVersion` 6) has its ownership re-proved by evaluation on open.
 *      The fixture is built by rewriting a v7 archive: the manifest is knocked
 *      back to 6 and every `sp` is deleted, and the spec ASSERTS both, so it
 *      cannot silently be testing the v7 path twice.
 *
 *   3. §3bi/F2 — the nine `TableSpecifier` forms round-trip through the repair
 *      walker. Three of them (`ColumnRange`, `ThisRowRange`, `SpecialColumn`)
 *      used to render as text the parser could not read back, and a defined
 *      name whose text will not re-parse becomes `=#REF!`. The route is a SHEET
 *      RENAME, which runs `repair_all_formulas` + `repair_named_ranges` over
 *      every formula and every defined name in the workbook.
 *
 *   4. §2ag — an Excel-illegal sheet name is refused AT ENTRY, with a message
 *      that names the rule, and the workbook is not touched. The other half of
 *      that decision (LOAD accepts and carries a name the rule rejects) is
 *      proved with a workbook whose manifest carries `Bad/Name`.
 *
 *   5. §3bi/F1+F3+F4 — a real `.xlsx` round trip: a grouped expression (which
 *      has no parenthesis node in the AST and depends entirely on the renderer's
 *      precedence guard), a dotted-name function (one of the 248 that used to
 *      Debug-format), and two error literals that used to come back `#VALUE!`.
 *
 *   6. §3bi/F5 — Ctrl+S onto an already-open `.xlsx` asks for lossy consent.
 *      Both answers are driven: Cancel must not write, OK must.
 *
 * VACUOUS-PASS DISCIPLINE. Every "still there after" is preceded by "there
 * before", read by the same reader. Every absence is preceded by the matching
 * presence — the shrink assertions are checked against cells proved non-empty a
 * moment earlier, and the reopen assertions are preceded by a File > New that is
 * asserted to have emptied the cell. The legacy fixture asserts its own
 * legacy-ness. The refusal tests assert that the thing refused was otherwise
 * achievable (a LEGAL rename of the same sheet succeeds first).
 *
 * NATIVE DIALOGS. `alertAsync` and `confirmAsync` raise real Win32 dialogs
 * through `tauri-plugin-dialog`; Tauri's IPC surface is non-writable so they can
 * be neither stubbed nor observed from inside the page. They are driven from
 * OUTSIDE with `e2e/answer-native-dialog.ps1`. A dialog left standing is owned
 * by the app and survives into every later spec, so `beforeEach` AND `afterEach`
 * sweep — writing this file left five stacked message boxes behind once.
 *
 * WHY A JOURNEY. It calls File > New and reads and writes real files.
 *
 * GRID REAL ESTATE. A..G rows 1..12 of workbooks this spec creates from
 * File > New, so nothing is shared with any other spec.
 *
 * LOCALE. sv-SE. No formula here needs a list separator except the structured
 * references, whose inner separator is the LIST separator (`;` on this machine)
 * and is normalised to the canonical `,` on the way in — which is why the
 * assertions below expect a comma in the stored text.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");

const WORK = path.join(os.tmpdir(), "calcula-reload-integrity");
const FILE_V7 = path.join(WORK, "spill-v7.cala");
const FILE_LEGACY = path.join(WORK, "spill-legacy-v6.cala");
const FILE_NO_EXTENT = path.join(WORK, "spill-v7-no-extent.cala");
const FILE_NAMES = path.join(WORK, "names.cala");
const FILE_ILLEGAL = path.join(WORK, "names-illegal.cala");
const FILE_XLSX = path.join(WORK, "roundtrip.xlsx");

// ---------------------------------------------------------------------------
// Plumbing — setup and oracles. Every gesture under test goes through the app.
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** Invoke and REPORT the rejection instead of throwing — for refusal tests. */
async function invokeResult(
  page: Page,
  cmd: string,
  args: unknown = {},
): Promise<{ ok: boolean; error: string }> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      try {
        await t.core.invoke(c, a);
        return { ok: true, error: "" };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    { c: cmd, a: args },
  );
}

async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      if (typeof m[fn] !== "function") {
        throw new Error(`${modulePath} exports no function "${fn}"`);
      }
      return (await m[fn](...(args as unknown[]))) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.waitForTimeout(900);
}

async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [target]);
  await page.waitForTimeout(2500);
}

async function setCell(page: Page, ref: string, value: string): Promise<void> {
  const { row, col } = parseCellRef(ref);
  await invoke(page, "update_cell", { row, col, value });
  await page.waitForTimeout(140);
}

interface CellSnapshot {
  display: string;
  formula: string;
}

async function cell(page: Page, ref: string): Promise<CellSnapshot> {
  const { row, col } = parseCellRef(ref);
  const c = await invoke<{ display?: string; formula?: string | null } | null>(page, "get_cell", {
    row,
    col,
  });
  return { display: c?.display ?? "", formula: c?.formula ?? "" };
}

/** The DISPLAY strings of a vertical run of cells, as the canvas paints them. */
async function column(page: Page, refs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs) out.push((await cell(page, r)).display);
  return out;
}

interface SpillRange {
  originRow: number;
  originCol: number;
  endRow: number;
  endCol: number;
}

async function spillRanges(page: Page): Promise<SpillRange[]> {
  return invoke<SpillRange[]>(page, "get_spill_ranges");
}

async function sheetNames(page: Page): Promise<string[]> {
  const res = await invoke<{ sheets: Array<{ name: string }> }>(page, "get_sheets");
  return res.sheets.map((s) => s.name);
}

async function namedRanges(page: Page): Promise<Array<{ name: string; refersTo: string }>> {
  return invoke(page, "get_all_named_ranges");
}

/** Rename through the tab bar's own event — the route the UI uses. */
async function requestRename(page: Page, index: number, newName: string): Promise<void> {
  await page.evaluate(
    ({ idx, name }) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestRename", { detail: { index: idx, newName: name } }),
      );
    },
    { idx: index, name: newName },
  );
}

// ---------------------------------------------------------------------------
// The native-dialog driver (shared with open-guard.spec.ts).
// ---------------------------------------------------------------------------

function driveNativeDialog(
  titleLike: string,
  action: "ok" | "cancel" | "read",
  waitMs = 20_000,
): { text: string; verdict: string } {
  if (!fs.existsSync(DIALOG_DRIVER)) {
    throw new Error(
      `the native-dialog driver is missing at ${DIALOG_DRIVER} — this spec cannot ` +
        `tell "no message appeared" from "nothing looked"`,
    );
  }
  let out: string;
  try {
    out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DIALOG_DRIVER,
        "-TitleLike",
        titleLike,
        "-Action",
        action,
        "-TimeoutMs",
        String(waitMs),
      ],
      { encoding: "utf-8", timeout: 90_000 },
    );
  } catch (e) {
    out = `DRIVERERROR:${String(e)}`;
  }
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    text: lines
      .filter((l) => l.startsWith("TEXT:"))
      .map((l) => l.slice(5))
      .join(" "),
    verdict: lines.find((l) => !l.startsWith("TEXT:")) ?? lines.join("|"),
  };
}

/**
 * Dismiss every native dialog the app currently owns.
 *
 * NOT tidiness. A message box left standing is owned by app.exe and survives
 * into every later spec in the run; an aborted pass while writing this file left
 * FIVE stacked "Calcula" boxes behind and everything downstream measured the
 * debris. Runs in `beforeEach` as well as `afterEach`, because the spec that ran
 * before this one may have left its own.
 */
function sweepNativeDialogs(): number {
  let closed = 0;
  // Both titles this file can raise: `alertAsync` without options titles its box
  // "Calcula"; the lossy-save consent titles its own "Save as .xlsx?".
  for (const title of ["Calcula", "Save as"]) {
    for (let i = 0; i < 12; i++) {
      const { verdict } = driveNativeDialog(title, "ok", 1500);
      if (!verdict.startsWith("CLICKED")) break;
      closed++;
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// The .cala archive, read and REWRITTEN. Used to build the pre-v7 corpus and
// the workbook carrying an Excel-illegal sheet name — both of which are files
// this build cannot produce, which is exactly why they have to be forged.
//
// The reader THROWS on any malformed entry: the assertions built on it are
// mostly absences, and "" satisfies every one of them.
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZip(file: string): ZipEntry[] {
  if (!fs.existsSync(file)) {
    throw new Error(`the archive is missing at ${file} — nothing was saved`);
  }
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`${file} has no ZIP end-of-central-directory record`);
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`${file}: central directory entry ${n} has a bad signature`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${file}: entry "${name}" has no local header at its recorded offset`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${file}: entry "${name}" uses unsupported compression method ${method}`);
    out.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (out.length === 0) throw new Error(`${file} contains no entries at all`);
  return out;
}

/** Write a STORED (method 0) ZIP. The `zip` crate reads both, and stored keeps
 *  the fixture inspectable by eye when one of these tests fails. */
function writeZip(file: string, entries: ZipEntry[]): void {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cdBuf, eocd]));
}

function archiveText(file: string): string {
  return readZip(file)
    .map((e) => `${e.name}\n${e.data.toString("utf8")}`)
    .join("\n");
}

/** Delete every `sp` key anywhere in a parsed JSON tree. */
function stripSpillExtents(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripSpillExtents);
  } else if (node && typeof node === "object") {
    delete (node as Record<string, unknown>).sp;
    Object.values(node as Record<string, unknown>).forEach(stripSpillExtents);
  }
}

// ===========================================================================

test.describe.serial("reload, refusal and .xlsx integrity — proved on the running app", () => {
  test.beforeAll(() => {
    fs.mkdirSync(WORK, { recursive: true });
    for (const f of [FILE_V7, FILE_LEGACY, FILE_NO_EXTENT, FILE_NAMES, FILE_ILLEGAL, FILE_XLSX]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test.beforeEach(() => {
    sweepNativeDialogs();
  });

  test.afterEach(() => {
    sweepNativeDialogs();
  });

  // =========================================================================
  // 1. §2ab — THE REOPENED ARRAY IS OWNED
  // =========================================================================
  test("§2ab: a reopened dynamic array is REBUILT, not restored as literals — it survives an edit, shrinks clean, grows, and refuses an edit", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    await setCell(page, "A1", "4");
    await setCell(page, "B1", "=SEQUENCE(A1)");
    await page.waitForTimeout(500);

    // ---- PRECONDITION: the array really spilled, in the grid and in the map.
    expect(
      await column(page, ["B1", "B2", "B3", "B4"]),
      "precondition: the array must be painted before its persistence can mean anything",
    ).toEqual(["1", "2", "3", "4"]);
    const live = await spillRanges(page);
    expect(live, "precondition: the live spill map must hold exactly this array").toEqual([
      { originRow: 0, originCol: 1, endRow: 3, endCol: 1 },
    ]);

    await invoke(page, "save_file", { path: FILE_V7, password: null });

    // ---- The archive is Excel's shape: the ORIGIN carries formula + extent,
    // the covered cells are value-only. Asserted on the BYTES, because this is
    // the whole of §3be's decision and a round trip through this build's own
    // reader cannot tell it from any other encoding.
    const v7Text = archiveText(FILE_V7);
    expect(
      v7Text,
      "the saved origin does not carry its spill extent — §3be's `sp` field is " +
        "what makes a reopened array owned rather than four loose literals",
    ).toContain('"sp": "B1:B4"');
    expect(
      v7Text,
      "the archive was not stamped format_version 7, so an older build would " +
        "read it, drop `sp`, and write the spilled cells back as ordinary literals",
    ).toContain('"formatVersion": 7');

    // ---- The WIPE. Without this the reopen assertions could pass against
    // state that was simply never cleared.
    await newFile(page);
    expect(
      (await cell(page, "B1")).display,
      "precondition: File > New must have emptied the cell, or the reopen below proves nothing",
    ).toBe("");
    expect(await spillRanges(page), "precondition: and emptied the spill map").toEqual([]);

    // =====================================================================
    // THE REOPEN.
    // =====================================================================
    await openAt(page, FILE_V7);

    expect(
      await column(page, ["B1", "B2", "B3", "B4"]),
      "the reopened workbook does not paint the array",
    ).toEqual(["1", "2", "3", "4"]);
    expect(
      await spillRanges(page),
      "THE §2ab DEFECT: the reopened workbook's spill map is empty. The four " +
        "values are there as loose literals owned by nothing — the origin has no " +
        "spill protection, and touching its input collapses it",
    ).toEqual([{ originRow: 0, originCol: 1, endRow: 3, endCol: 1 }]);

    // ---- THE §2ab PROBE, VERBATIM (step 3): edit the input to the SAME value.
    // Pre-§3be this turned the origin into #VALUE! — the array died on an edit
    // that changed nothing.
    await setCell(page, "A1", "4");
    await page.waitForTimeout(500);
    expect(
      await column(page, ["B1", "B2", "B3", "B4"]),
      "editing the array's input killed the reopened array: the origin cannot " +
        "re-spill onto cells it does not own, so it answers #VALUE!",
    ).toEqual(["1", "2", "3", "4"]);
    expect(
      await spillRanges(page),
      "and the ownership did not survive the recalculation either",
    ).toEqual([{ originRow: 0, originCol: 1, endRow: 3, endCol: 1 }]);

    // ---- THE LENGTH CHANGE (step 4) — the case §3be calls the hardest to see.
    // Guarded against vacuity: B3 and B4 are proved non-empty first, by the
    // same reader, immediately above.
    await setCell(page, "A1", "2");
    await page.waitForTimeout(600);
    expect(
      await column(page, ["B1", "B2", "B3", "B4"]),
      "the array shrank and its old tail stayed on the grid: 3 and 4 are sitting " +
        "under a live origin, presented as its output, with no error anywhere",
    ).toEqual(["1", "2", "", ""]);
    expect(
      await spillRanges(page),
      "the map still claims the cells the shrunken array no longer covers",
    ).toEqual([{ originRow: 0, originCol: 1, endRow: 1, endCol: 1 }]);

    // ---- AND IT GROWS (step 5).
    await setCell(page, "A1", "6");
    await page.waitForTimeout(600);
    expect(
      await column(page, ["B1", "B2", "B3", "B4", "B5", "B6"]),
      "the array did not grow back after a reopen",
    ).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(await spillRanges(page), "and the map did not follow it").toEqual([
      { originRow: 0, originCol: 1, endRow: 5, endCol: 1 },
    ]);

    // ---- AND ONE OF ITS CELLS CANNOT BE TYPED INTO (step 6). This is the
    // assertion that distinguishes "the values came back" from "the ownership
    // came back": literals are editable, a spilled cell is not.
    const refused = await invokeResult(page, "update_cell", { row: 1, col: 1, value: "X" });
    expect(
      refused.ok,
      "typing into a reopened array's spilled cell was ACCEPTED — the cells are " +
        "loose literals, not an array",
    ).toBe(false);
    expect(
      refused.error,
      "the refusal must name the origin, or the user cannot act on it",
    ).toContain("spilled array value from cell");
    expect(
      (await cell(page, "B2")).display,
      "the refused edit changed the cell anyway",
    ).toBe("2");
  });

  // =========================================================================
  // 2. THE LEGACY CORPUS
  // =========================================================================
  test("§3be legacy corpus: a pre-v7 .cala carrying no extent still opens with its array owned", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // ---- Forge the pre-change file from the v7 one: knock the manifest back
    // to 6, drop the `spill_extents` feature, and delete every `sp`.
    const entries = readZip(FILE_V7);
    let sawExtent = false;
    let originalVersion: number | null = null;
    for (const e of entries) {
      if (e.name === "manifest.json") {
        const m = JSON.parse(e.data.toString("utf8")) as {
          formatVersion: number;
          features?: string[];
        };
        originalVersion = m.formatVersion;
        m.formatVersion = 6;
        m.features = (m.features ?? []).filter((f) => f !== "spill_extents");
        e.data = Buffer.from(JSON.stringify(m, null, 2), "utf8");
      } else if (e.name.endsWith("data.json")) {
        const text = e.data.toString("utf8");
        if (/"sp"\s*:/.test(text)) sawExtent = true;
        const parsed = JSON.parse(text) as unknown;
        stripSpillExtents(parsed);
        e.data = Buffer.from(JSON.stringify(parsed, null, 2), "utf8");
      }
    }
    expect(
      originalVersion,
      "the source archive was not v7, so knocking it back to 6 forges nothing",
    ).toBe(7);
    expect(
      sawExtent,
      "the source archive carried no `sp` at all, so stripping it changes nothing " +
        "and this test would be running the v7 path a second time",
    ).toBe(true);
    writeZip(FILE_LEGACY, entries);

    // ---- The fixture asserts its OWN legacy-ness.
    const legacyText = archiveText(FILE_LEGACY);
    expect(legacyText, "the forged file still carries a spill extent").not.toContain('"sp"');
    expect(legacyText, "the forged file is not stamped v6").toContain('"formatVersion": 6');
    expect(
      legacyText,
      "precondition: the forged file must still hold the spilled values as plain " +
        "literals — that is what the pre-change build wrote and what the recovery " +
        "re-proves its ownership from",
    ).toContain('"B4"');

    await newFile(page);
    expect((await cell(page, "B1")).display, "precondition: the wipe").toBe("");

    await openAt(page, FILE_LEGACY);

    expect(
      await column(page, ["B1", "B2", "B3", "B4"]),
      "the legacy workbook lost its values",
    ).toEqual(["1", "2", "3", "4"]);
    expect(
      await spillRanges(page),
      "a workbook written by the pre-change build opened with NO ownership: the " +
        "recovery-by-evaluation pass either did not run or declined. Every array " +
        "already on a user's disk is in this state",
    ).toEqual([{ originRow: 0, originCol: 1, endRow: 3, endCol: 1 }]);

    // ---- And it behaves like an array, not like four literals.
    await setCell(page, "A1", "2");
    await page.waitForTimeout(600);
    expect(
      await column(page, ["B1", "B2", "B3", "B4"]),
      "the recovered array shrank and left its old tail behind",
    ).toEqual(["1", "2", "", ""]);
  });

  // =========================================================================
  // 2b. THE TEETH — the same two tests, run against a file with the ownership
  //     taken out, must REPRODUCE the original defect.
  // =========================================================================
  test("TEETH: an archive stamped v7 with its extent deleted opens UNOWNED and collapses on the first edit — which is what §2ab was", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // The one sabotage the two tests above cannot make of themselves: strip
    // `sp` but LEAVE the v7 stamp, so the restore finds nothing AND the pre-v7
    // recovery is gated off. If the arrays above were coming back owned because
    // of something that always runs — a post-load recalculation, a leftover
    // session map — this file would come back owned too.
    const entries = readZip(FILE_V7);
    for (const e of entries) {
      if (!e.name.endsWith("data.json")) continue;
      const parsed = JSON.parse(e.data.toString("utf8")) as unknown;
      stripSpillExtents(parsed);
      e.data = Buffer.from(JSON.stringify(parsed, null, 2), "utf8");
    }
    writeZip(FILE_NO_EXTENT, entries);
    const text = archiveText(FILE_NO_EXTENT);
    expect(text, "the sabotage did not remove the extent").not.toContain('"sp"');
    expect(
      text,
      "the sabotage must KEEP the v7 stamp — that is what gates the pre-v7 " +
        "recovery off and isolates the extent as the only source of ownership",
    ).toContain('"formatVersion": 7');

    await newFile(page);
    await openAt(page, FILE_NO_EXTENT);

    // THE COLLAPSE NOW HAPPENS AT LOAD, NOT AT THE FIRST EDIT — and that is a
    // FIX arriving, not this teeth test going stale unnoticed.
    //
    // This assertion read `["1","2","3","4"]` until 2026-08-11, on the reasoning
    // that "the defect was never about the values". It is now `#SPILL!` in the
    // origin, and the reason is §3bs: the recalculation pass runs on load and it
    // SPILLS now — it used to collapse an array to its first element and write
    // that. So the origin re-evaluates, finds B2:B4 occupied by literals it does
    // not own (the sabotage removed the ownership and left the values), and
    // reports the Excel answer for that: `#SPILL!`.
    //
    // The teeth are unchanged and are arguably sharper. What this test exists to
    // prove is that ownership comes from the FILE and from nowhere else, and the
    // proof is the empty `spillRanges` below plus the origin refusing to behave
    // like an array. It now refuses one gesture earlier and says why.
    expect(
      (await cell(page, "B1")).display,
      "an unowned origin loaded and behaved like an array anyway — ownership is " +
        "coming from somewhere other than the file's extent, so the two tests " +
        "above prove nothing about persistence",
    ).toBe("#SPILL!");
    expect(
      await column(page, ["B2", "B3", "B4"]),
      "precondition: the VALUES are still in the file and must still load — the " +
        "defect was never about the values",
    ).toEqual(["2", "3", "4"]);
    expect(
      await spillRanges(page),
      "the ownership came from somewhere OTHER than the file's extent, so the two " +
        "tests above prove nothing about persistence",
    ).toEqual([]);

    await setCell(page, "A1", "2");
    await page.waitForTimeout(600);
    // `#SPILL!`, not `#VALUE!`. This assertion read `#VALUE!` until 2026-08-11
    // and it was STALE, not wrong about the behaviour: §3bg/§2an gave the engine
    // a `CellError::Spill` variant, so a blocked array now says WHICH kind of
    // failure it is instead of being indistinguishable from a bad argument. The
    // origin still collapses — that is what this teeth check is measuring — it
    // just spells the collapse correctly now.
    //
    // Nobody caught the drift because the batch that landed `#SPILL!` ran no
    // E2E, and this is a journey. It is recorded here rather than quietly
    // updated because "a fix silently invalidated a TEETH test" is precisely
    // the failure mode a teeth test exists to prevent in the other direction.
    expect(
      (await cell(page, "B1")).display,
      "the unowned origin did not collapse — §2ab's symptom is not reproducible, " +
        "so the tests above are not measuring it",
    ).toBe("#SPILL!");
    expect(
      await column(page, ["B2", "B3", "B4"]),
      "and the stale tail must still be sitting there, which is the other half of " +
        "what §2ab looked like",
    ).toEqual(["2", "3", "4"]);
  });

  // =========================================================================
  // 3. §3bi/F2 — THE NINE STRUCTURED-REFERENCE FORMS
  // =========================================================================
  test("§3bi/F2: all nine structured-reference forms survive the repair walker byte-identically", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    for (const [ref, value] of [
      ["A1", "Amount"],
      ["B1", "Qty"],
      ["C1", "Rate"],
      ["A2", "10"],
      ["B2", "2"],
      ["C2", "3"],
      ["A3", "20"],
      ["B3", "4"],
      ["C3", "5"],
      ["A4", "30"],
      ["B4", "6"],
      ["C4", "7"],
    ] as const) {
      await setCell(page, ref, value);
    }
    const created = await invoke<{ success: boolean }>(page, "create_table", {
      params: {
        name: "Sales",
        startRow: 0,
        startCol: 0,
        endRow: 3,
        endCol: 2,
        hasHeaders: true,
      },
    });
    expect(created.success, "the fixture table was not created").toBe(true);

    // The nine `TableSpecifier` variants, in Excel's spelling. A DEFINED NAME is
    // the route that keeps them: a structured reference typed into a CELL is
    // resolved to a plain range at entry, so the specifier never reaches the
    // stored AST — `refers_to` is where one survives, and `repair_named_ranges`
    // re-renders every one of them on a sheet rename.
    const SPECIFIERS: ReadonlyArray<readonly [string, string]> = [
      ["NCol", "=Sales[Amount]"],
      ["NThisRow", "=Sales[@Amount]"],
      ["NColRange", "=Sales[[Amount]:[Rate]]"],
      ["NThisRowRange", "=Sales[[@Amount]:[@Rate]]"],
      ["NAll", "=Sales[#All]"],
      ["NData", "=Sales[#Data]"],
      ["NHeaders", "=Sales[#Headers]"],
      ["NTotals", "=Sales[#Totals]"],
      ["NSpecial", "=Sales[[#Data],[Amount]]"],
    ];
    for (const [name, refersTo] of SPECIFIERS) {
      const res = await invoke<{ success: boolean; error?: string | null }>(
        page,
        "create_named_range",
        { name, sheetIndex: null, refersTo, comment: null, folder: null },
      );
      expect(res.success, `the fixture name "${name}" was not created: ${res.error ?? ""}`).toBe(
        true,
      );
    }

    // THE COUNTERWEIGHT, defined last so it is unmistakable: a name that MUST
    // follow the rename. Without it a repair walker that had simply stopped
    // running would pass every assertion below.
    await invoke(page, "create_named_range", {
      name: "Follower",
      sheetIndex: null,
      refersTo: "=Sheet1!$A$1",
      comment: null,
      folder: null,
    });

    const before = new Map((await namedRanges(page)).map((n) => [n.name, n.refersTo]));
    for (const [name, refersTo] of SPECIFIERS) {
      expect(
        before.get(name),
        `precondition: "${name}" must be stored as written before a rename can preserve it`,
      ).toBe(refersTo);
    }
    expect(before.get("Follower"), "precondition: the counterweight").toBe("=Sheet1!$A$1");

    // =====================================================================
    // THE GESTURE: rename the sheet. Every defined name in the workbook now
    // goes through parse -> reference-shift -> render -> re-parse.
    // =====================================================================
    await requestRename(page, 0, "Facts");
    await expect
      .poll(async () => (await sheetNames(page))[0], {
        timeout: 20_000,
        intervals: [250],
        message: "the sheet never took the name Facts",
      })
      .toBe("Facts");
    await page.waitForTimeout(800);

    const after = new Map((await namedRanges(page)).map((n) => [n.name, n.refersTo]));
    expect(
      after.get("Follower"),
      "the repair walker did not run at all — the counterweight did not follow the " +
        "rename, so every 'unchanged' assertion below is vacuous",
    ).toBe("=Facts!$A$1");

    for (const [name, refersTo] of SPECIFIERS) {
      expect(
        after.get(name),
        `renaming a sheet destroyed the structured reference in "${name}". The ` +
          `serialiser wrote a form the parser cannot read back, the re-parse failed, ` +
          `and the name was rewritten to =#REF! — on a rename that has nothing to ` +
          `do with the table`,
      ).toBe(refersTo);
    }
  });

  // =========================================================================
  // 4. §2ag — SHEET NAMES: ENTRY REFUSES, LOAD CARRIES
  // =========================================================================
  test("§2ag: an Excel-illegal sheet name is refused with a message and changes nothing; a workbook already carrying one still opens", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await newFile(page);
    await setCell(page, "A1", "111");
    await setCell(page, "A2", "=A1*2");
    await page.waitForTimeout(300);

    // ---- THE COUNTERWEIGHT FIRST: a LEGAL rename of the same sheet, through
    // the same route, succeeds. A build that refused every rename would pass
    // the refusal assertions below and fail here.
    await requestRename(page, 0, "Data");
    await expect
      .poll(async () => (await sheetNames(page))[0], {
        timeout: 20_000,
        intervals: [250],
        message: "a LEGAL rename was refused — the refusals below prove nothing",
      })
      .toBe("Data");

    // ---- Each illegal name: refused, named, and nothing changed.
    const ILLEGAL: ReadonlyArray<readonly [string, string]> = [
      ["Bad/Name", "not allowed"],
      ["History", "History"],
      ["a".repeat(32), "31 characters"],
      ["'lead", "apostrophe"],
      ["Has[Bracket]", "not allowed"],
    ];
    for (const [name, fragment] of ILLEGAL) {
      await requestRename(page, 0, name);
      const seen = driveNativeDialog("Calcula", "ok", 15_000);
      expect(
        seen.text,
        `renaming the sheet to ${JSON.stringify(name)} raised no message at all — ` +
          `the refusal is silent, and a user who typed it sees a tab that simply ` +
          `did not change`,
      ).toContain("Failed to rename sheet");
      expect(
        seen.text,
        `the message does not say WHY ${JSON.stringify(name)} was refused`,
      ).toContain(fragment);
      expect(
        (await sheetNames(page))[0],
        `the illegal name ${JSON.stringify(name)} was applied anyway`,
      ).toBe("Data");
      expect(
        (await cell(page, "A2")).formula,
        "a refused rename rewrote a formula — the whole point of the pre-flight is " +
          "that a refusal writes NOTHING",
      ).toBe("=A1*2");
    }

    // ---- THE OTHER HALF: LOAD accepts and carries. A workbook already on disk
    // may hold a name the rule rejects; refusing it at load would trade a
    // cosmetic problem for a total one.
    await invoke(page, "save_file", { path: FILE_NAMES, password: null });
    const entries = readZip(FILE_NAMES);
    let renamed = false;
    for (const e of entries) {
      if (e.name !== "manifest.json") continue;
      const m = JSON.parse(e.data.toString("utf8")) as { sheets: Array<{ name: string }> };
      expect(m.sheets[0].name, "the saved manifest does not name the sheet we renamed").toBe(
        "Data",
      );
      m.sheets[0].name = "Bad/Name";
      e.data = Buffer.from(JSON.stringify(m, null, 2), "utf8");
      renamed = true;
    }
    expect(renamed, "the archive has no manifest.json — the fixture was not forged").toBe(true);
    writeZip(FILE_ILLEGAL, entries);

    await newFile(page);
    expect((await cell(page, "A1")).display, "precondition: the wipe").toBe("");

    await openAt(page, FILE_ILLEGAL);
    expect(
      await sheetNames(page),
      "a workbook carrying a name the ENTRY rule rejects was refused at LOAD, or " +
        "had its name silently rewritten — §2ag's decision is that load accepts and " +
        "carries, because refusing to open the user's file is the worse trade",
    ).toEqual(["Bad/Name"]);
    expect(
      await column(page, ["A1", "A2"]),
      "the carried-name workbook did not bring its data",
    ).toEqual(["111", "222"]);
  });

  // =========================================================================
  // 5. THE .xlsx ROUND TRIP
  // =========================================================================
  test("§3bi: a grouped expression, a dotted-name function and two error literals survive a real .xlsx round trip", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    await setCell(page, "A1", "3");
    await setCell(page, "B1", "4");
    await setCell(page, "C1", "5");
    await setCell(page, "D1", "=(A1+B1)*C1");
    await setCell(page, "E1", "=STDEV.S(A1:C1)");
    await setCell(page, "F1", "=1/0");
    await setCell(page, "G1", "=NA()");
    await page.waitForTimeout(500);

    const before = {
      D1: await cell(page, "D1"),
      E1: await cell(page, "E1"),
      F1: await cell(page, "F1"),
      G1: await cell(page, "G1"),
    };
    expect(before.D1, "precondition: the grouped expression must be 35, not 23").toEqual({
      display: "35",
      formula: "=(A1+B1)*C1",
    });
    expect(before.E1.formula, "precondition: the dotted name is spelled STDEV.S").toBe(
      "=STDEV.S(A1:C1)",
    );
    expect(before.E1.display, "precondition: and it evaluates").toBe("1");
    expect(before.F1.display, "precondition: a real #DIV/0!").toBe("#DIV/0!");
    expect(before.G1.display, "precondition: a real #N/A").toBe("#N/A");

    await invoke(page, "save_file", { path: FILE_XLSX, password: null });
    expect(fs.existsSync(FILE_XLSX), "nothing was written to the .xlsx path").toBe(true);
    // It is a REAL .xlsx, not a .cala with the wrong extension — otherwise this
    // whole test round-trips through Calcula's own format and proves nothing
    // about the one other applications read.
    const xlsxNames = readZip(FILE_XLSX).map((e) => e.name);
    expect(
      xlsxNames,
      "the file written to the .xlsx path is not an OOXML package",
    ).toContain("xl/worksheets/sheet1.xml");

    await newFile(page);
    expect((await cell(page, "D1")).display, "precondition: the wipe").toBe("");

    await openAt(page, FILE_XLSX);

    expect(
      await cell(page, "D1"),
      "the parentheses did not survive the .xlsx round trip: `=(A1+B1)*C1` came " +
        "back as `=A1+B1*C1`, so the cell now computes 23 instead of 35. This is " +
        "the file format OTHER applications read",
    ).toEqual({ display: "35", formula: "=(A1+B1)*C1" });
    expect(
      await cell(page, "E1"),
      "the dotted function name did not survive: either the writer emitted the " +
        "Rust variant name, or the reader kept Excel's `_xlfn.` prefix, and either " +
        "way the cell is #NAME? on the way back",
    ).toEqual({ display: "1", formula: "=STDEV.S(A1:C1)" });
    expect(
      (await cell(page, "F1")).display,
      "every error imported from .xlsx used to become #VALUE!, because calamine " +
        "reports its Debug name (`Div0`) and nothing matched it",
    ).toBe("#DIV/0!");
    expect((await cell(page, "G1")).display, "the same for #N/A").toBe("#N/A");
  });

  // =========================================================================
  // 6. §3bi/F5 — LOSSY-SAVE CONSENT ON Ctrl+S
  // =========================================================================
  test("§3bi/F5: Ctrl+S onto an already-open .xlsx asks for consent — Cancel does not write, OK does", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    // The workbook opened by the previous test IS the .xlsx, which is the whole
    // point: `saveFile` takes the current path and used to go straight to the
    // backend with no consent of its own.
    expect(
      (await invoke<string | null>(page, "get_current_file_path"))?.toLowerCase(),
      "precondition: the open document must BE the .xlsx for Ctrl+S to be the " +
        "lossy path",
    ).toBe(FILE_XLSX.toLowerCase());

    // Give the workbook something .xlsx cannot carry. Without this the consent
    // prompt does not appear AT ALL and every assertion below would be vacuous.
    expect(
      await invoke<string[]>(page, "xlsx_save_loss_report"),
      "precondition: the workbook must start with nothing to lose",
    ).toEqual([]);
    await invoke(page, "group_rows", { params: { startRow: 9, endRow: 11 } });
    expect(
      await invoke<string[]>(page, "xlsx_save_loss_report"),
      "the fixture did not create anything an .xlsx would drop",
    ).toEqual(["Outline groups"]);

    const sizeBefore = fs.statSync(FILE_XLSX).size;
    const mtimeBefore = fs.statSync(FILE_XLSX).mtimeMs;

    /** Start `saveFile()` WITHOUT awaiting it — it blocks on a native dialog. */
    async function startSave(): Promise<void> {
      await page.evaluate(async () => {
        const w = window as unknown as {
          __calcImport: (u: string) => Promise<unknown>;
          __reloadIntegritySave?: Promise<string | null>;
        };
        const m = (await w.__calcImport(
          new URL("/src/core/lib/file-api.ts", document.baseURI).href,
        )) as { saveFile: () => Promise<string | null> };
        w.__reloadIntegritySave = m.saveFile();
      });
    }
    async function saveResult(): Promise<string | null> {
      return page.evaluate(async () => {
        const w = window as unknown as { __reloadIntegritySave?: Promise<string | null> };
        const r = (await w.__reloadIntegritySave) ?? null;
        delete w.__reloadIntegritySave;
        return r;
      });
    }

    // ---- CANCEL.
    await startSave();
    const cancelled = driveNativeDialog("Save as", "cancel", 20_000);
    expect(
      cancelled.text,
      "Ctrl+S onto an open .xlsx raised NO consent prompt — the shortcut people " +
        "use most destroyed the workbook's non-xlsx features in silence",
    ).toContain("Saving as .xlsx will NOT include");
    expect(
      cancelled.text,
      "the prompt does not say WHAT is about to be lost",
    ).toContain("Outline groups");
    expect(await saveResult(), "Cancel still reported a save").toBeNull();
    await page.waitForTimeout(600);
    expect(
      fs.statSync(FILE_XLSX).mtimeMs,
      "the file was written even though the user cancelled — the classic " +
        "`if (!window.confirm(...))` bug, where the guard tests `!Promise`",
    ).toBe(mtimeBefore);
    expect(
      await invoke<string[]>(page, "xlsx_save_loss_report"),
      "and the outline must still be in the document after a cancelled save",
    ).toEqual(["Outline groups"]);

    // ---- OK. The counterweight: a consent that could not be granted would
    // pass everything above.
    await page.waitForTimeout(1200);
    await startSave();
    const accepted = driveNativeDialog("Save as", "ok", 20_000);
    expect(accepted.text, "the second prompt never appeared").toContain(
      "Saving as .xlsx will NOT include",
    );
    expect(
      (await saveResult())?.toLowerCase(),
      "granting consent did not report the saved path",
    ).toBe(FILE_XLSX.toLowerCase());
    await page.waitForTimeout(800);
    const after = fs.statSync(FILE_XLSX);
    expect(
      after.mtimeMs !== mtimeBefore || after.size !== sizeBefore,
      "consent was granted and the file was not written",
    ).toBe(true);
  });
});
