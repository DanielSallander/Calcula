/**
 * INSERT > IMAGE — the binary ingress, live.
 *
 * This is the first E2E for Insert > Image. The feature shipped with no
 * validation of any kind: a hidden `<input type="file">` IN THE WEBVIEW,
 * `FileReader.readAsDataURL` over the whole file, and the base64 stored verbatim
 * as the control property `src`. No size cap, no format check, no dimension
 * check; a non-image fell back to a 200x150 placeholder over bytes it had
 * ALREADY embedded, and everything travelled on into the saved `.cala` and into
 * published `.calp` artifacts under the signature.
 *
 * The unit and Rust tests assert the gate in isolation. What they cannot show is
 * that the REPLACEMENT is what a user actually gets, so everything here is
 * driven through the product:
 *
 *   * the real Insert > Image menu item, and the real NATIVE file dialog. Tauri
 *     defines its IPC surface with `Object.defineProperty(..., { value })` —
 *     writable:false, configurable:false — so the dialog cannot be stubbed from
 *     the page (see dirty-flag-close.spec.ts). It is therefore answered from
 *     OUTSIDE, by typing a path into the Win32 common dialog's file-name edit
 *     box, exactly as a user would.
 *   * the picture is asserted to RENDER, by sampling the grid canvas.
 *   * the persisted `src` is read out of the SAVED `.cala` ARCHIVE — the actual
 *     artifact, parsed here, not a value the app reported about itself.
 *
 * WHY THIS IS A JOURNEY. It saves, wipes (`new_file`) and reopens the document.
 * The functional specs share one accumulating workbook and one set of screenshot
 * baselines; a spec that replaces the document shifts unrelated goldens.
 *
 * THE TWO PROBES, AND WHY THEY HAVE TEETH
 *
 *   "did the document gain a control?"  -> get_control_metadata at the anchor.
 *   "did the document gain the BYTES?"  -> resolve_media_ref("media:" + sha256
 *                                          of the fixture file). The handle is
 *                                          content-addressed, so this asks about
 *                                          THAT file and no other.
 *
 * Both are asserted in BOTH directions in this spec: the accepted PNG resolves
 * and the refused files do not, from the same probe. A refusal assertion that
 * could only ever pass is worthless, and this one is shown failing-if-broken by
 * its own positive case.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { readGridGeometry, type GridHelper } from "../helpers/grid";

// ---------------------------------------------------------------------------
// The caps under test, mirrored from core/calcula-format/src/media.rs.
// ---------------------------------------------------------------------------
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

const WORK = path.join(os.tmpdir(), "calcula-image-ingress");
const SAVED = path.join(WORK, "picture.cala");
const RESAVED = path.join(WORK, "picture-resaved.cala");
const LEGACY = path.join(WORK, "legacy-inline.cala");
const LEGACY_MIGRATED = path.join(WORK, "legacy-migrated.cala");
/** The PowerShell helper that answers the native dialog; written at setup. */
const DIALOG_PS1 = path.join(WORK, "answer-file-dialog.ps1");

// ---------------------------------------------------------------------------
// PNG synthesis — real files, really decodable
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/**
 * A REAL PNG: valid IHDR, a real deflated IDAT, correct CRCs.
 *
 * Not a header stub. The WebView has to decode these for the pixel probe to mean
 * anything, and the byte-cap fixture has to be a file whose ONLY broken rule is
 * its size — `noise` makes it incompressible so it can exceed 8 MiB at a pixel
 * count far below the pixel cap.
 */
function makePng(
  width: number,
  height: number,
  rgb: [number, number, number],
  noise = false,
): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      if (noise) {
        raw[o++] = (x * 7 + y * 13 + ((x * y) % 251)) & 0xff;
        raw[o++] = (x * 31 + y * 17 + ((x + y) % 199)) & 0xff;
        raw[o++] = (x * 97 + y * 3 + ((x ^ y) % 233)) & 0xff;
      } else {
        raw[o++] = rgb[0];
        raw[o++] = rgb[1];
        raw[o++] = rgb[2];
      }
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: noise ? 0 : 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const sha256 = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

/** The picture that must WORK: 120x90 solid red, a few hundred bytes. */
const RED = makePng(120, 90, [220, 30, 40]);
/** A second, visibly different picture — proves dedup counts CONTENT. */
const BLUE = makePng(120, 90, [30, 60, 220]);
/** A third, never inserted — the byte-level probe for the script refusal. */
const GREEN = makePng(120, 90, [20, 190, 70]);
/**
 * Over the byte cap and NOTHING else: 1600x1400 = 2.24 MP (the pixel cap is
 * 40 MP), stored uncompressed so it lands around 9 MB. If the cap were removed
 * this file would be admitted, which is what makes the refusal meaningful.
 */
const OVERSIZE = makePng(1600, 1400, [0, 0, 0], true);
/**
 * The SAME construction as OVERSIZE — noise pixels, deflate level 0 — but small
 * enough to admit. It exists to make the byte-cap refusal ATTRIBUTABLE: without
 * it, "the 9 MB noise PNG was refused" could equally mean this test builds PNGs
 * the gate dislikes for some other reason. This one must be ACCEPTED.
 */
const UNDERSIZE_NOISE = makePng(200, 150, [0, 0, 0], true);
/** A ZIP, named `.png`. The extension lies; the magic bytes do not. */
const NOT_AN_IMAGE = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("this is not a picture, it is a zip. ".repeat(40), "utf-8"),
]);
/** An SVG: accepted by the old picker's `accept` list, refused by this build. */
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
  "utf-8",
);

const F = {
  red: path.join(WORK, "logo-red.png"),
  blue: path.join(WORK, "logo-blue.png"),
  oversize: path.join(WORK, "too-big.png"),
  undersizeNoise: path.join(WORK, "noise-small.png"),
  notAnImage: path.join(WORK, "definitely-not-an-image.png"),
  svg: path.join(WORK, "logo.svg"),
};

const HASH = {
  red: sha256(RED),
  blue: sha256(BLUE),
  green: sha256(GREEN),
  oversize: sha256(OVERSIZE),
  undersizeNoise: sha256(UNDERSIZE_NOISE),
  notAnImage: sha256(NOT_AN_IMAGE),
  svg: sha256(SVG),
};

// ---------------------------------------------------------------------------
// The native-dialog answerer
//
// Self-contained on purpose: the spec writes its own helper rather than
// depending on a script that lives outside the repo.
// ---------------------------------------------------------------------------

const ANSWER_DIALOG_PS1 = String.raw`
param([string]$Path = "", [switch]$Cancel)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Dlg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$procIds = @(Get-Process -Name "app" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($procIds.Count -eq 0) { Write-Output "NODIALOG"; exit 0 }
$dialog = [IntPtr]::Zero
$cb = [Dlg+EnumProc]{
  param($hWnd, $lParam)
  $p = 0
  [Dlg]::GetWindowThreadProcessId($hWnd, [ref]$p) | Out-Null
  if ($procIds -contains [int]$p) {
    $cls = New-Object System.Text.StringBuilder 256
    [Dlg]::GetClassName($hWnd, $cls, 256) | Out-Null
    if ($cls.ToString() -eq "#32770" -and [Dlg]::IsWindowVisible($hWnd)) { $script:dialog = $hWnd; return $false }
  }
  return $true
}
[Dlg]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($dialog -eq [IntPtr]::Zero) { Write-Output "NODIALOG"; exit 0 }
[Dlg]::SetForegroundWindow($dialog) | Out-Null
Start-Sleep -Milliseconds 250
if ($Cancel) {
  [Dlg]::PostMessageW($dialog, 0x0111, [IntPtr]2, [IntPtr]::Zero) | Out-Null
  Write-Output ("OK " + [int64]$dialog)
  exit 0
}
$edit = [IntPtr]::Zero
$ecb = [Dlg+EnumProc]{
  param($hWnd, $lParam)
  $cls = New-Object System.Text.StringBuilder 256
  [Dlg]::GetClassName($hWnd, $cls, 256) | Out-Null
  if ($cls.ToString() -eq "Edit" -and [Dlg]::IsWindowVisible($hWnd)) { $script:edit = $hWnd; return $false }
  return $true
}
[Dlg]::EnumChildWindows($dialog, $ecb, [IntPtr]::Zero) | Out-Null
if ($edit -eq [IntPtr]::Zero) { Write-Output "NOEDIT"; exit 0 }
[Dlg]::SendMessageW($edit, 0x000C, [IntPtr]::Zero, $Path) | Out-Null
Start-Sleep -Milliseconds 250
[Dlg]::PostMessageW($dialog, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
Write-Output ("OK " + [int64]$dialog)
`;

/** One attempt at answering a native dialog. "NODIALOG" when none is open. */
function answerNativeDialog(filePath: string | null): string {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_PS1];
  if (filePath === null) args.push("-Cancel");
  else args.push("-Path", filePath);
  try {
    return execFileSync("powershell", args, { encoding: "utf-8", timeout: 30_000 }).trim();
  } catch (err) {
    return `PSERROR ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Poll until the app raises a native file dialog, then answer it. */
async function answerWhenRaised(page: Page, filePath: string | null): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(400);
    const result = answerNativeDialog(filePath);
    if (result.startsWith("OK")) return;
    if (result.startsWith("PSERROR")) throw new Error(`dialog helper failed: ${result}`);
  }
  throw new Error("the native file dialog never appeared");
}

// ---------------------------------------------------------------------------
// Backend access
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
      }).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** The control at an anchor, or null when the document has none there. */
async function controlAt(
  page: Page,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<{ controlType: string; properties: Record<string, { valueType: string; value: string }> } | null> {
  return invoke(page, "get_control_metadata", { sheetIndex, row, col });
}

/** The `src` this document holds for the control at an anchor, or "". */
async function srcAt(page: Page, sheetIndex: number, row: number, col: number): Promise<string> {
  const meta = await controlAt(page, sheetIndex, row, col);
  return meta?.properties?.src?.value ?? "";
}

/**
 * Does the OPEN DOCUMENT hold the bytes of this file?
 *
 * `resolve_media_ref` is the one route from a handle back to bytes and it
 * re-runs the gate, so a `true` here means the store really holds an admissible
 * image under that content hash — not merely that some key exists.
 */
async function documentHoldsBytes(page: Page, hash: string): Promise<boolean> {
  return page.evaluate(async (h) => {
    const t = (window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
    }).__TAURI__;
    try {
      const url = (await t.core.invoke("resolve_media_ref", { mediaRef: `media:${h}` })) as string;
      return typeof url === "string" && url.startsWith("data:image/");
    } catch {
      return false;
    }
  }, hash);
}

/** How many controls the sheet holds — the "no control was created" probe. */
async function controlCount(page: Page, sheetIndex = 0): Promise<number> {
  const all = await invoke<unknown[]>(page, "get_all_controls", { sheetIndex });
  return Array.isArray(all) ? all.length : 0;
}

// ---------------------------------------------------------------------------
// Document lifecycle, through the app's OWN file API (the functions the File
// menu calls), so the frontend refreshes exactly as it does for a user.
// ---------------------------------------------------------------------------

async function fileApi<T>(page: Page, fn: string, arg?: string): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const mod = (await (window as unknown as {
        __calcImport: (u: string) => Promise<Record<string, (a?: unknown) => Promise<unknown>>>;
      }).__calcImport(new URL("/src/core/lib/file-api.ts", document.baseURI).href));
      return (await mod[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}

const newDocument = (page: Page) => fileApi<void>(page, "newFile");
const openDocument = (page: Page, file: string) => fileApi<unknown>(page, "openFileAtPath", file);

/** Save to a path. `save_file` is where the media sweep runs. */
async function saveDocument(page: Page, file: string): Promise<void> {
  await invoke(page, "save_file", { path: file });
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// The saved `.cala` ARCHIVE, read here rather than reported by the app
// ---------------------------------------------------------------------------

interface Archive {
  /** Every entry name in the archive. */
  names: string[];
  /** `media/{sha256}` entries, by hash. */
  media: Map<string, Buffer>;
  /** The raw text of `controls.json`, or "" when the archive has none. */
  controlsJson: string;
}

/**
 * A minimal ZIP reader. Deliberately dependency-free and written here: this is
 * the assertion that `controls.json` carries no bytes, and it must not be able
 * to inherit a bug from the code that wrote the file.
 */
function readCala(file: string): Archive {
  const buf = fs.readFileSync(file);
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a ZIP archive (no end-of-central-directory)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const names: string[] = [];
  const media = new Map<string, Buffer>();
  let controlsJson = "";

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
    names.push(name);

    const wanted = name === "controls.json" || name.startsWith("media/");
    if (wanted) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("corrupt local header");
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
      if (name === "controls.json") controlsJson = data.toString("utf-8");
      else if (!name.endsWith("/")) media.set(name.slice("media/".length), data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { names, media, controlsJson };
}

// ---------------------------------------------------------------------------
// The canvas pixel probe
// ---------------------------------------------------------------------------

/**
 * The picture's top-left corner in CANVAS CSS pixels.
 *
 * Uses the SAME live geometry the click helpers use (`readGridGeometry`), so a
 * resized column, a hidden row, the scroll offset and the zoom factor are all
 * accounted for rather than assumed. A hard-coded cell size here would make the
 * probe sample the wrong pixels the day a default changes — and a probe that
 * samples empty grid always reports "not painted".
 */
async function pictureOrigin(
  page: Page,
  row: number,
  col: number,
): Promise<{ x: number; y: number; zoom: number }> {
  const geo = await readGridGeometry(page);
  const hiddenCols = new Set(geo.hiddenCols);
  const hiddenRows = new Set(geo.hiddenRows);
  let xOffset = 0;
  for (let c = 0; c < col; c++) {
    xOffset += hiddenCols.has(c) ? 0 : geo.columnWidths[c] ?? geo.defaultCellWidth;
  }
  let yOffset = 0;
  for (let r = 0; r < row; r++) {
    yOffset += hiddenRows.has(r) ? 0 : geo.rowHeights[r] ?? geo.defaultCellHeight;
  }
  return {
    x: (geo.rowHeaderWidth + xOffset - geo.scrollX) * geo.zoom,
    y: (geo.colHeaderHeight + yOffset - geo.scrollY) * geo.zoom,
    zoom: geo.zoom,
  };
}

type Pixel = [number, number, number];

/** Read a css-pixel patch out of the grid canvas (overlays paint onto it). */
async function samplePatch(page: Page, x: number, y: number, w: number, h: number): Promise<Pixel[]> {
  return page.evaluate(
    ({ x, y, w, h }) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) throw new Error("grid canvas not found");
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const img = ctx.getImageData(
        Math.max(0, Math.round(x * scale)),
        Math.max(0, Math.round(y * scale)),
        Math.max(1, Math.round(w * scale)),
        Math.max(1, Math.round(h * scale)),
      );
      const out: Array<[number, number, number]> = [];
      for (let i = 0; i < img.data.length; i += 4) {
        out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
      return out;
    },
    { x, y, w, h },
  );
}

const isRed = ([r, g, b]: Pixel): boolean => r >= 170 && g <= 90 && b <= 90;
const isBlue = ([r, g, b]: Pixel): boolean => b >= 160 && r <= 100 && g <= 120;

function fraction(px: Pixel[], pred: (p: Pixel) => boolean): number {
  return px.length === 0 ? 0 : px.filter(pred).length / px.length;
}

/**
 * The fraction of the picture's box painted in its colour.
 *
 * Samples the INTERIOR (a 40x40 patch inset from the top-left corner) so the
 * selection chrome and the 1px control border cannot be mistaken for the image.
 */
async function pictureColourFraction(
  page: Page,
  row: number,
  col: number,
  pred: (p: Pixel) => boolean,
): Promise<number> {
  await page.waitForTimeout(300);
  const origin = await pictureOrigin(page, row, col);
  const inset = 20 * origin.zoom;
  const side = 40 * origin.zoom;
  return fraction(await samplePatch(page, origin.x + inset, origin.y + inset, side, side), pred);
}

/** Poll until the picture has painted (media resolution is async). */
async function waitForPicture(
  page: Page,
  row: number,
  col: number,
  pred: (p: Pixel) => boolean,
): Promise<number> {
  let best = 0;
  for (let i = 0; i < 20; i++) {
    best = Math.max(best, await pictureColourFraction(page, row, col, pred));
    if (best > 0.9) return best;
    await page.waitForTimeout(400);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Toasts — the channel a refusal speaks through
// ---------------------------------------------------------------------------

async function toastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-toast]")).map((n) => n.textContent ?? ""),
  );
}

async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click());
  });
  await page.waitForTimeout(150);
}

/** Wait for a toast to appear and return every toast text on screen. */
async function waitForToast(page: Page): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const texts = await toastTexts(page);
    if (texts.length > 0) return texts.join(" | ");
    await page.waitForTimeout(300);
  }
  return "";
}

// ---------------------------------------------------------------------------
// The real Insert > Image flow
// ---------------------------------------------------------------------------

/**
 * Insert a picture the way a user does: select the cell, Insert > Image, pick
 * the file in the native dialog.
 *
 * The menu item's action is fired without being awaited by `MenuBar` (it opens a
 * modal native dialog), so the click promise is deliberately not awaited here —
 * the dialog is answered from the other side while it is open.
 */
async function insertImageViaUi(
  grid: GridHelper,
  cellRef: string,
  filePath: string | null,
): Promise<void> {
  const page = grid.page;
  await grid.navigateTo(cellRef);
  await page.waitForTimeout(200);
  await grid.openMenu("Insert");
  const item = page.locator("button").filter({ hasText: /^Image$/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  void item.click({ timeout: 5_000 }).catch(() => {
    /* the action opens a modal dialog; a click timeout here is not the outcome */
  });
  await answerWhenRaised(page, filePath);
  // Give the host time to read + validate the file and the extension time to
  // create (or refuse to create) the control.
  await page.waitForTimeout(1_500);
}

// ---------------------------------------------------------------------------

test.describe.serial("Insert > Image — binary ingress", () => {
  test.beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(DIALOG_PS1, ANSWER_DIALOG_PS1, "utf-8");
    fs.writeFileSync(F.red, RED);
    fs.writeFileSync(F.blue, BLUE);
    fs.writeFileSync(F.oversize, OVERSIZE);
    fs.writeFileSync(F.undersizeNoise, UNDERSIZE_NOISE);
    fs.writeFileSync(F.notAnImage, NOT_AN_IMAGE);
    fs.writeFileSync(F.svg, SVG);
    // The byte-cap fixture is only meaningful if it really is over the cap, and
    // only ATTRIBUTABLE if its small twin is under it.
    expect(OVERSIZE.length).toBeGreaterThan(MAX_MEDIA_BYTES);
    expect(UNDERSIZE_NOISE.length).toBeLessThan(MAX_MEDIA_BYTES);
    expect(RED.length).toBeLessThan(MAX_MEDIA_BYTES);
  });

  // -------------------------------------------------------------------------
  // 1 + 6. A normal image works, renders, stores a handle — and dedupes.
  // -------------------------------------------------------------------------

  test("a real PNG inserted through Insert > Image renders, and controls.json holds a handle rather than bytes", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;
    await newDocument(page);
    await page.waitForTimeout(500);

    // The document starts with nothing — the baseline both probes are read
    // against, and the proof they are not simply always-true.
    expect(await controlCount(page)).toBe(0);
    expect(await documentHoldsBytes(page, HASH.red)).toBe(false);

    // CANCEL first. This proves the flow is really gated on the native dialog:
    // the menu item was clicked, a real dialog opened, and dismissing it created
    // nothing. Everything below is therefore attributable to the file CHOSEN,
    // not to the menu click.
    await insertImageViaUi(grid, "B3", null);
    expect(await controlAt(page, 0, 2, 1), "cancelling the picker created a control").toBeNull();
    expect(await controlCount(page)).toBe(0);

    await insertImageViaUi(grid, "B3", F.red);

    // (a) A control exists at the anchor, and it is an image.
    const meta = await controlAt(page, 0, 2, 1);
    expect(meta, "Insert > Image created no control").not.toBeNull();
    expect(meta!.controlType).toBe("image");

    // (b) `src` is a media HANDLE for exactly these bytes, and holds no base64.
    const src = await srcAt(page, 0, 2, 1);
    expect(src).toBe(`media:${HASH.red}`);
    expect(src).not.toContain("data:");
    expect(src).not.toContain("base64");
    expect(src.length).toBe("media:".length + 64);

    // (c) The bytes are in the document, under their content hash.
    expect(await documentHoldsBytes(page, HASH.red)).toBe(true);

    // (d) The size came from the HEADER the host parsed (120x90 -> unscaled).
    expect(meta!.properties.width.value).toBe("120");
    expect(meta!.properties.height.value).toBe("90");

    // (e) IT RENDERS. The picture is solid #DC1E28; the empty grid is white.
    await grid.navigateTo("A1");
    const painted = await waitForPicture(page, 2, 1, isRed);
    expect(painted, "the picture did not paint on the grid canvas").toBeGreaterThan(0.9);

    // ---- DEDUP: the SAME file again is one blob and two controls. ----------
    await insertImageViaUi(grid, "F3", F.red);
    expect(await srcAt(page, 0, 2, 5)).toBe(`media:${HASH.red}`);
    // ...and a DIFFERENT picture is a second blob, so dedup is by content and
    // not "every insert reuses the first blob".
    await insertImageViaUi(grid, "B12", F.blue);
    expect(await srcAt(page, 0, 11, 1)).toBe(`media:${HASH.blue}`);
    expect(await documentHoldsBytes(page, HASH.blue)).toBe(true);

    await grid.navigateTo("A1");
    expect(await waitForPicture(page, 11, 1, isBlue), "the second picture did not paint")
      .toBeGreaterThan(0.9);

    expect(await controlCount(page)).toBe(3);

    // ---- THE ARCHIVE. Read the artifact, not the app's account of it. ------
    await saveDocument(page, SAVED);
    const archive = readCala(SAVED);

    // Three controls, two blobs: the same logo twice is ONE `media/` entry.
    expect(archive.media.size, `media entries: ${[...archive.media.keys()].join(", ")}`).toBe(2);
    expect(archive.media.has(HASH.red)).toBe(true);
    expect(archive.media.has(HASH.blue)).toBe(true);
    // Byte-for-byte, through save and the ZIP.
    expect(Buffer.compare(archive.media.get(HASH.red)!, RED)).toBe(0);
    expect(Buffer.compare(archive.media.get(HASH.blue)!, BLUE)).toBe(0);
    expect(archive.names).toContain(`media/${HASH.red}`);

    // controls.json names the handles and carries NO bytes.
    expect(archive.controlsJson).toContain(`media:${HASH.red}`);
    expect(archive.controlsJson).toContain(`media:${HASH.blue}`);
    expect(archive.controlsJson).not.toContain("data:image");
    expect(archive.controlsJson).not.toContain("base64");
    // The first 32 base64 characters of the file cannot appear anywhere in it.
    expect(archive.controlsJson).not.toContain(RED.toString("base64").slice(0, 32));
    // Three controls' worth of JSON is small. Before this change the same
    // document's controls.json carried the whole PNG twice.
    expect(archive.controlsJson.length).toBeLessThan(4_000);
  });

  // -------------------------------------------------------------------------
  // 2. Save -> wipe -> reopen. The bytes now live in a different section.
  // -------------------------------------------------------------------------

  test("save, wipe and reopen: the picture survives and still renders", async ({ grid }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // The previous test saved SAVED with three pictures. WIPE.
    await newDocument(page);
    await page.waitForTimeout(800);

    // The wipe is real: no controls, and the bytes are gone from the session
    // store. Without this the reopen below could pass on residue.
    expect(await controlCount(page)).toBe(0);
    expect(await documentHoldsBytes(page, HASH.red)).toBe(false);
    expect(await documentHoldsBytes(page, HASH.blue)).toBe(false);
    await grid.navigateTo("A1");
    expect(
      await pictureColourFraction(page, 2, 1, isRed),
      "the wipe left the picture on the canvas",
    ).toBeLessThan(0.1);

    // REOPEN.
    await openDocument(page, SAVED);
    await page.waitForTimeout(1_500);

    expect(await controlCount(page)).toBe(3);
    expect(await srcAt(page, 0, 2, 1)).toBe(`media:${HASH.red}`);
    expect(await srcAt(page, 0, 2, 5)).toBe(`media:${HASH.red}`);
    expect(await srcAt(page, 0, 11, 1)).toBe(`media:${HASH.blue}`);
    expect(await documentHoldsBytes(page, HASH.red)).toBe(true);
    expect(await documentHoldsBytes(page, HASH.blue)).toBe(true);

    await grid.navigateTo("A1");
    expect(await waitForPicture(page, 2, 1, isRed), "the reopened picture did not paint")
      .toBeGreaterThan(0.9);
    expect(await waitForPicture(page, 11, 1, isBlue), "the reopened second picture did not paint")
      .toBeGreaterThan(0.9);

    // A second save round-trip keeps the archive shape (and does not re-inline).
    await saveDocument(page, RESAVED);
    const again = readCala(RESAVED);
    expect(again.media.size).toBe(2);
    expect(Buffer.compare(again.media.get(HASH.red)!, RED)).toBe(0);
    expect(again.controlsJson).not.toContain("data:image");
  });

  // -------------------------------------------------------------------------
  // 3. THE REFUSALS — the reason this work exists.
  // -------------------------------------------------------------------------

  const refusals: Array<{
    what: string;
    file: () => string;
    hash: () => string;
    cell: string;
    anchor: [number, number];
    expectMessage: RegExp[];
    /** A twin file that differs ONLY in the rule under test, and must pass. */
    alsoAdmit?: { file: () => string; hash: () => string; cell: string; anchor: [number, number] };
  }> = [
    {
      what: "a file over the byte cap is refused with the limit named",
      file: () => F.oversize,
      hash: () => HASH.oversize,
      cell: "B20",
      anchor: [19, 1],
      expectMessage: [/the limit is 8388608 bytes/i, new RegExp(String(OVERSIZE.length))],
      alsoAdmit: {
        file: () => F.undersizeNoise,
        hash: () => HASH.undersizeNoise,
        cell: "B16",
        anchor: [15, 1],
      },
    },
    {
      what: "a non-image renamed to .png is refused on its magic bytes",
      file: () => F.notAnImage,
      hash: () => HASH.notAnImage,
      cell: "E20",
      anchor: [19, 4],
      expectMessage: [/not a PNG, JPEG, GIF or WebP image/i],
    },
    {
      what: "an SVG is refused",
      file: () => F.svg,
      hash: () => HASH.svg,
      cell: "H20",
      anchor: [19, 7],
      expectMessage: [/SVG images cannot be embedded/i],
    },
  ];

  for (const r of refusals) {
    test(r.what, async ({ grid }) => {
      test.setTimeout(240_000);
      const page = grid.page;
      await newDocument(page);
      await page.waitForTimeout(600);
      await dismissToasts(page);

      const controlsBefore = await controlCount(page);
      expect(controlsBefore).toBe(0);
      expect(await documentHoldsBytes(page, r.hash())).toBe(false);

      if (r.alsoAdmit) {
        // ATTRIBUTABILITY. A twin file built exactly like the refused one, but
        // on the right side of the rule under test, must be ACCEPTED. Without
        // this the refusal below could be the gate disliking how this spec
        // synthesises PNGs rather than the rule it is supposed to be proving.
        await insertImageViaUi(grid, r.alsoAdmit.cell, r.alsoAdmit.file());
        expect(
          await srcAt(page, 0, r.alsoAdmit.anchor[0], r.alsoAdmit.anchor[1]),
          "the admissible twin was refused too — the refusal below proves nothing",
        ).toBe(`media:${r.alsoAdmit.hash()}`);
        await newDocument(page);
        await page.waitForTimeout(600);
        await dismissToasts(page);
        expect(await controlCount(page)).toBe(0);
      }

      await insertImageViaUi(grid, r.cell, r.file());

      // (a) The user is TOLD, and told which rule the file broke.
      const toast = await waitForToast(page);
      expect(toast, "the refusal was silent — no toast").not.toBe("");
      for (const pattern of r.expectMessage) {
        expect(toast).toMatch(pattern);
      }

      // (b) NO CONTROL. The shipped path created a 200x150 placeholder here.
      expect(
        await controlAt(page, 0, r.anchor[0], r.anchor[1]),
        "a control was created for a refused file",
      ).toBeNull();
      expect(await controlCount(page)).toBe(controlsBefore);

      // (c) NO BYTES. The shipped path had already embedded the whole file.
      expect(
        await documentHoldsBytes(page, r.hash()),
        "the refused file's bytes entered the document",
      ).toBe(false);

      // (d) And nothing reaches the archive either.
      const probe = path.join(WORK, `refused-${r.anchor.join("-")}.cala`);
      await saveDocument(page, probe);
      const archive = readCala(probe);
      expect(archive.media.size).toBe(0);
      expect(archive.controlsJson).not.toContain("data:image");
      expect(archive.controlsJson).not.toContain(r.file().split(/[\\/]/).pop()!);

      await dismissToasts(page);
    });
  }

  // -------------------------------------------------------------------------
  // 4. A SCRIPT cannot introduce bytes.
  // -------------------------------------------------------------------------

  test("a script's shape.setProperty refuses a data: URL for src and accepts a media handle", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // A document that HOLDS a picture, so the accept half has a real handle to
    // write and the refusal cannot be "there was no media anyway".
    await newDocument(page);
    await page.waitForTimeout(500);
    await insertImageViaUi(grid, "B3", F.red);
    expect(await documentHoldsBytes(page, HASH.red)).toBe(true);

    // A SHAPE control for the script to mount on: `shape.setProperty` hardcodes
    // the control type "shape", and a control's type is immutable after
    // creation, so this aspect can only ever address a shape.
    const SHEET = 0;
    const ROW = 25;
    const COL = 3;
    const instanceId = `control-${SHEET}-${ROW}-${COL}`;
    await invoke(page, "set_control_metadata", {
      sheetIndex: SHEET,
      row: ROW,
      col: COL,
      metadata: {
        controlType: "shape",
        properties: { shapeType: { valueType: "static", value: "rectangle" } },
      },
    });
    await page.waitForTimeout(300);

    // The payload is GREEN — a perfectly valid PNG this document has never seen.
    // That makes "did the document gain these bytes?" a question with a real
    // answer: if the validator let it through, the store would hold GREEN's hash
    // and nothing else in this spec would have put it there.
    const dataUrl = `data:image/png;base64,${GREEN.toString("base64")}`;
    expect(await documentHoldsBytes(page, HASH.green)).toBe(false);

    const outcome = await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const { ObjectScriptManager } = api;
        const scriptDef = {
          id: "img-ingress-" + a.instanceId,
          name: "Image Ingress Probe",
          objectType: "shape",
          instanceId: a.instanceId,
          // UNLOCKED on purpose: the widest tier there is. If the refusal below
          // still happens, it is the VALIDATOR refusing the value — not the
          // capability tier refusing the caller.
          accessLevel: "unlocked",
          description: null,
          source: `
            async function setup(shape) {
              globalThis.__probe = { data: null, handle: null };
              try {
                await shape.setProperty("src", ${JSON.stringify(a.dataUrl)});
                globalThis.__probe.data = "ACCEPTED";
              } catch (e) {
                globalThis.__probe.data = "REFUSED: " + String((e && e.message) || e);
              }
              try {
                await shape.setProperty("src", ${JSON.stringify(a.handle)});
                globalThis.__probe.handle = "ACCEPTED";
              } catch (e) {
                globalThis.__probe.handle = "REFUSED: " + String((e && e.message) || e);
              }
              shape.api.setCellValue(${a.reportRow}, ${a.reportCol},
                globalThis.__probe.data + " || " + globalThis.__probe.handle);
            }
          `,
        };
        try {
          ObjectScriptManager.registerScript(scriptDef);
          await ObjectScriptManager.mountScript(scriptDef.id);
          const tauri = (window as any).__TAURI__;
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 400));
            const cell = await tauri.core.invoke("get_cell", {
              row: a.reportRow,
              col: a.reportCol,
            });
            const v = String(cell?.display ?? cell?.value ?? "");
            if (v.length > 0) return v;
          }
          return "";
        } finally {
          try {
            ObjectScriptManager.unmountScript(scriptDef.id);
            ObjectScriptManager.removeScript(scriptDef.id);
          } catch {
            /* best effort */
          }
        }
      },
      { instanceId, dataUrl, handle: `media:${HASH.red}`, reportRow: 27, reportCol: 3 },
    );

    expect(outcome, "the probe script never reported").not.toBe("");
    const [dataOutcome, handleOutcome] = outcome.split(" || ");

    // (a) The data: URL is REFUSED, and the message says what a src may be.
    expect(dataOutcome).toContain("REFUSED");
    expect(dataOutcome).toMatch(/media handle/i);
    expect(dataOutcome).toMatch(/64 hex characters/i);
    expect(dataOutcome).toMatch(/data: URI/i);

    // (b) A real handle is ACCEPTED — so (a) is the value being refused, not
    //     the aspect being closed.
    expect(handleOutcome).toBe("ACCEPTED");

    // (c) And the persisted property is the handle. Nothing the script tried
    //     put a byte into the document.
    await page.waitForTimeout(800);
    expect(await srcAt(page, SHEET, ROW, COL)).toBe(`media:${HASH.red}`);
    expect(
      await documentHoldsBytes(page, HASH.green),
      "the script's data: URL bytes entered the media store",
    ).toBe(false);

    const probe = path.join(WORK, "script-write.cala");
    await saveDocument(page, probe);
    const archive = readCala(probe);
    expect(archive.controlsJson).not.toContain("data:image");
    expect(archive.controlsJson).not.toContain(GREEN.toString("base64").slice(0, 32));
    expect(archive.media.has(HASH.green)).toBe(false);
    // The picture the USER inserted is still there — the shape write did not
    // disturb it, so "nothing got in" is not "nothing works".
    expect(archive.media.has(HASH.red)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. THE LEGACY CORPUS. A `.cala` holding an inline data: image.
  // -------------------------------------------------------------------------

  test("a legacy .cala with an inline data: image migrates on open, still renders, and stays migrated", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // Build the legacy artifact the way the SHIPPED build produced one: the
    // whole file base64'd into the control property `src`, and no `media/`
    // section at all. Written through the app's own save path, so this is a real
    // archive rather than one this test synthesised.
    await newDocument(page);
    await page.waitForTimeout(600);
    const dataUrl = `data:image/png;base64,${BLUE.toString("base64")}`;
    await invoke(page, "set_control_metadata", {
      sheetIndex: 0,
      row: 4,
      col: 2,
      metadata: {
        controlType: "image",
        properties: {
          src: { valueType: "static", value: dataUrl },
          opacity: { valueType: "static", value: "1" },
          rotation: { valueType: "static", value: "0" },
          pinToGrid: { valueType: "static", value: "false" },
          x: { valueType: "static", value: "128" },
          y: { valueType: "static", value: "80" },
          width: { valueType: "static", value: "120" },
          height: { valueType: "static", value: "90" },
        },
      },
    });
    await saveDocument(page, LEGACY);

    // The fixture really IS the legacy shape — otherwise the migration below
    // would be asserting nothing.
    const legacyArchive = readCala(LEGACY);
    expect(legacyArchive.media.size, "the legacy corpus has no media section").toBe(0);
    expect(legacyArchive.controlsJson).toContain("data:image/png;base64,");
    expect(legacyArchive.controlsJson).toContain(BLUE.toString("base64").slice(0, 32));

    // Wipe, then OPEN it.
    await newDocument(page);
    await page.waitForTimeout(800);
    expect(await documentHoldsBytes(page, HASH.blue)).toBe(false);

    await openDocument(page, LEGACY);
    await page.waitForTimeout(1_500);

    // (a) The picture is still there — and its src is now a HANDLE.
    const meta = await controlAt(page, 0, 4, 2);
    expect(meta, "the legacy picture was lost on open").not.toBeNull();
    expect(meta!.controlType).toBe("image");
    const src = await srcAt(page, 0, 4, 2);
    expect(src).toBe(`media:${HASH.blue}`);
    expect(src).not.toContain("data:");

    // (b) The bytes moved into the media store, unchanged.
    expect(await documentHoldsBytes(page, HASH.blue)).toBe(true);

    // (c) IT RENDERS.
    await grid.navigateTo("A1");
    expect(await waitForPicture(page, 4, 2, isBlue), "the migrated picture did not paint")
      .toBeGreaterThan(0.9);

    // (d) IT STUCK: save and reopen. The archive now carries `media/` and its
    //     controls.json holds no bytes.
    await saveDocument(page, LEGACY_MIGRATED);
    const migrated = readCala(LEGACY_MIGRATED);
    expect(migrated.media.size).toBe(1);
    expect(Buffer.compare(migrated.media.get(HASH.blue)!, BLUE)).toBe(0);
    expect(migrated.controlsJson).toContain(`media:${HASH.blue}`);
    expect(migrated.controlsJson).not.toContain("data:image");
    expect(migrated.controlsJson).not.toContain(BLUE.toString("base64").slice(0, 32));

    await newDocument(page);
    await page.waitForTimeout(600);
    await openDocument(page, LEGACY_MIGRATED);
    await page.waitForTimeout(1_500);
    expect(await srcAt(page, 0, 4, 2)).toBe(`media:${HASH.blue}`);
    expect(await documentHoldsBytes(page, HASH.blue)).toBe(true);
    await grid.navigateTo("A1");
    expect(
      await waitForPicture(page, 4, 2, isBlue),
      "the re-opened migrated picture did not paint",
    ).toBeGreaterThan(0.9);
  });

  test.afterAll(async () => {
    // Leave nothing behind for the next journey: the app is shared.
    for (const f of [SAVED, RESAVED, LEGACY, LEGACY_MIGRATED]) {
      fs.rmSync(f, { force: true });
    }
  });
});
