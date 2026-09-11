//! FILENAME: app/scripts/lib/artifact.mjs
// PURPOSE: Download a pinned artifact, prove it is the pinned bytes, and read
//          members out of a zip — the three things both fetch scripts need.
// CONTEXT: The bundled inference runtime (fetch-llama-server.mjs) and the
//          on-board model (fetch-builtin-model.mjs) are fetched from the
//          network at build or setup time, never checked into the repo. What
//          keeps that honest is the PIN: a size and a sha256 written into the
//          script, checked before anything is extracted or installed. A byte
//          that differs from the pin is refused with the two hashes printed,
//          never "repaired" by trusting the server.
//
//          Pure Node, deliberately: no PowerShell Expand-Archive, no 7-Zip, no
//          npm dependency. The release runner, the dev box and CI all have
//          Node and nothing else in common that can be relied on. The zip
//          reader covers what the llama.cpp archives use (stored and deflate
//          members, no zip64) and refuses anything else by name rather than
//          producing a wrong file.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";

/** sha256 of a file as lowercase hex, streamed so a 1 GB model is not read into memory. */
export async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

/** Bytes as "1,066 MB" / "18.4 MB" / "512 KB". */
export function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 100 * 1024 * 1024) return `${Math.round(n / (1024 * 1024)).toLocaleString("en-US")} MB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * Download `url` to `dest`, resuming a previous partial download, and refuse
 * the result unless it is exactly `size` bytes with sha256 `sha256`.
 *
 * RESUME IS A RANGE REQUEST, NOT A GUESS. A `dest.part` left by an earlier
 * run is continued with `Range: bytes=<have>-`; a server that answers 200
 * instead of 206 has ignored the range and the partial file is discarded
 * rather than appended to (that would splice two copies of the head
 * together). The final hash is computed over the whole file, so a resumed
 * download is held to the same pin as a fresh one.
 *
 * @param {string} url
 * @param {string} dest
 * @param {{size: number, sha256: string, log?: (line: string) => void, label?: string}} pin
 */
export async function downloadPinned(url, dest, pin) {
  const log = pin.log ?? ((line) => console.log(line));
  const label = pin.label ?? path.basename(dest);
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    const actual = await sha256File(dest);
    if (actual === pin.sha256 && fs.statSync(dest).size === pin.size) {
      log(`[fetch] ${label}: already present and matches the pin.`);
      return { downloaded: false, path: dest };
    }
    log(`[fetch] ${label}: present but does NOT match the pin (sha256 ${actual}); re-downloading.`);
    fs.rmSync(dest);
  }

  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch {
    have = 0;
  }
  if (have >= pin.size) {
    // A .part at or past the full size is not a resume candidate; it is junk.
    fs.rmSync(part, { force: true });
    have = 0;
  }

  const headers = { "user-agent": "calcula-fetch/1" };
  if (have > 0) headers.range = `bytes=${have}-`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (have > 0 && res.status === 200) {
    log(`[fetch] ${label}: the server ignored the resume request; starting over.`);
    fs.rmSync(part, { force: true });
    have = 0;
  } else if (have > 0 && res.status !== 206) {
    throw new Error(`${label}: resume refused with HTTP ${res.status} ${res.statusText}`);
  } else if (have === 0 && res.status !== 200) {
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  if (!res.body) throw new Error(`${label}: the response carried no body`);

  const remaining = Number(res.headers.get("content-length") ?? "0");
  const total = have + remaining;
  if (remaining > 0 && total !== pin.size) {
    throw new Error(
      `${label}: the server offers ${total.toLocaleString("en-US")} bytes but the pin says ` +
        `${pin.size.toLocaleString("en-US")}. The artifact changed; refusing to download it.`,
    );
  }

  log(
    `[fetch] ${label}: ${have > 0 ? `resuming at ${formatBytes(have)} of ` : "downloading "}` +
      `${formatBytes(pin.size)} from ${url}`,
  );
  const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
  let received = have;
  let nextReport = Math.floor((received / pin.size) * 20) + 1;
  const started = Date.now();
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    received += chunk.length;
    const step = Math.floor((received / pin.size) * 20);
    if (step >= nextReport) {
      nextReport = step + 1;
      const secs = Math.max(0.001, (Date.now() - started) / 1000);
      const rate = (received - have) / secs;
      log(
        `[fetch] ${label}: ${Math.min(100, step * 5)}% (${formatBytes(received)} of ` +
          `${formatBytes(pin.size)}, ${formatBytes(rate)}/s)`,
      );
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  const size = fs.statSync(part).size;
  if (size !== pin.size) {
    throw new Error(
      `${label}: download ended at ${size.toLocaleString("en-US")} bytes, pin says ` +
        `${pin.size.toLocaleString("en-US")}. The partial file is kept for a resume.`,
    );
  }
  log(`[fetch] ${label}: verifying sha256…`);
  const actual = await sha256File(part);
  if (actual !== pin.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(
      `${label}: sha256 MISMATCH.\n    pinned  ${pin.sha256}\n    actual  ${actual}\n` +
        "  The downloaded bytes are not the pinned artifact. Nothing was installed.",
    );
  }
  fs.renameSync(part, dest);
  log(`[fetch] ${label}: verified (${formatBytes(size)}, sha256 matches the pin).`);
  return { downloaded: true, path: dest };
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * The central directory of a zip: one entry per member with everything needed
 * to read it. Throws on zip64 markers and on anything that is not a zip.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, method: number, compressedSize: number, size: number, crc32: number, localOffset: number}>}
 */
export function listZip(buf) {
  // The end-of-central-directory record is the last 22 bytes plus a comment
  // of up to 65535 bytes; scan backwards for its signature.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported by this reader");
  }

  const members = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`corrupt zip: central directory entry ${i} has a bad signature`);
    }
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 member "${name}" is not supported by this reader`);
    }
    members.push({ name, method, compressedSize, size, crc32, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

/**
 * The bytes of one member, inflated and checked against its recorded size
 * and CRC-32.
 *
 * @param {Buffer} buf
 * @param {ReturnType<typeof listZip>[number]} member
 */
export function readZipMember(buf, member) {
  const p = member.localOffset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw new Error(`corrupt zip: member "${member.name}" has a bad local header`);
  }
  // The LOCAL header's own name/extra lengths decide where the data starts;
  // the extra field there can differ from the central directory's copy.
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + member.compressedSize);
  let data;
  if (member.method === 0) data = Buffer.from(raw);
  else if (member.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`member "${member.name}" uses compression method ${member.method}, which this reader does not support`);
  if (data.length !== member.size) {
    throw new Error(
      `member "${member.name}" inflated to ${data.length} bytes, the archive says ${member.size}`,
    );
  }
  const crc = zlib.crc32(data);
  if (crc !== member.crc32) {
    throw new Error(`member "${member.name}" failed its CRC-32 check`);
  }
  return data;
}

/**
 * Extract the members whose base name satisfies `keep` into `destDir`,
 * FLATTENED: the archive's own folder layout is dropped, because the runtime
 * is spawned from one directory and Windows resolves a sidecar's DLLs from
 * the directory the executable sits in.
 *
 * @param {string} zipPath
 * @param {(baseName: string) => boolean} keep
 * @param {string} destDir
 * @returns {string[]} the base names written
 */
export function extractZipMembers(zipPath, keep, destDir) {
  const buf = fs.readFileSync(zipPath);
  const members = listZip(buf);
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  const seen = new Set();
  for (const member of members) {
    if (member.name.endsWith("/")) continue;
    const base = path.posix.basename(member.name);
    if (!keep(base)) continue;
    if (seen.has(base)) {
      throw new Error(`the archive holds two members named "${base}" in different folders; refusing to flatten them`);
    }
    seen.add(base);
    fs.writeFileSync(path.join(destDir, base), readZipMember(buf, member));
    written.push(base);
  }
  return written;
}
