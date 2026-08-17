//! FILENAME: core/calcula-format/src/media.rs
//! PURPOSE: The one gate every byte of embedded binary media passes through.
//!
//! Media (today: pictures) is the first BINARY to enter a Calcula document.
//! Everything before it was text the user typed or JSON this crate wrote. That
//! makes this module the whole of the trust boundary, and it is deliberately
//! small enough to read in one sitting.
//!
//! WHAT THIS DOES
//!   * magic bytes  — the file must actually BE the format it claims
//!   * a hard byte cap — refuse, never truncate
//!   * header-only dimensions — parsed by byte offset, nothing decoded
//!   * a pixel cap independent of the byte cap (see MAX_MEDIA_PIXELS)
//!
//! WHAT THIS DELIBERATELY DOES NOT DO
//!   * decode. No image crate is linked, and none should be. The `image` crate
//!     sits in Cargo.lock TRANSITIVELY (via `arboard`, for clipboard bitmaps)
//!     and nothing calls it; linking a full decoder into the PRIVILEGED Rust
//!     process purely to learn two integers would trade a 300-line parser for
//!     tens of thousands of lines of format-parsing attack surface. The WebView
//!     does the real decode, in the renderer, where a malformed image is a
//!     broken <img> rather than a memory-safety question.
//!
//! ALLOWLIST: PNG, JPEG, GIF, WebP. Nothing else, ever, without an entry here.
//!
//! REFUSED ON PURPOSE:
//!   * SVG — has NO magic bytes (it is XML, optionally preceded by a comment, a
//!     BOM, a doctype or arbitrary whitespace), carries no header dimensions,
//!     and admitting it means admitting an XML parser plus a scripting host
//!     into the document. It was in the old picker's `accept` list; it is gone.
//!   * BMP — has a header and magic bytes, so it could be admitted cheaply, and
//!     it is still refused: BMP is uncompressed, so an ordinary screenshot is
//!     tens of megabytes of document for an image every other format stores in
//!     hundreds of kilobytes. There is no reason to carry one in a report.

use std::fmt;

/// Hard per-file byte cap: 8 MiB.
///
/// WHY THIS NUMBER. A logo is kilobytes. A full-width report banner at print
/// resolution is a few hundred kilobytes. A photographic screenshot from a
/// 4K display, saved as PNG, is the realistic worst case a user legitimately
/// drops into a report: roughly 3-5 MB. 8 MiB clears that with headroom and
/// refuses everything above it.
///
/// The ceiling matters more than the typical case, because these bytes are
/// resident three times over: `.cala` is read and written as ONE in-memory
/// `Vec<u8>` (see `read_calcula_bytes` / `write_calcula_bytes`), the media map
/// holds a second copy, and encryption makes a third. A document with twenty
/// pictures at this cap is therefore ~160 MB of media and ~480 MB of peak save
/// footprint — already the point at which the cap is doing real work, and two
/// orders of magnitude below the unbounded pick it replaces.
pub const MAX_MEDIA_BYTES: usize = 8 * 1024 * 1024;

/// Hard cap on either dimension: 12,000 px.
///
/// 12,000 px is 40 inches at 300 dpi — larger than any logo, banner or chart
/// export a report has a use for.
pub const MAX_MEDIA_DIMENSION: u32 = 12_000;

/// Hard cap on total pixels: 40 megapixels.
///
/// THIS CAP IS NOT REDUNDANT WITH THE BYTE CAP, and that is the entire reason
/// the header is parsed at all rather than just sniffed. Every admitted format
/// is compressed, so bytes on disk say nothing about pixels after decode: a
/// 30,000 x 30,000 single-colour PNG compresses to a few kilobytes, sails
/// through an 8 MiB byte cap, and asks the WebView for 3.6 GB of RGBA. That is
/// a decompression bomb, and only a dimension check catches it.
///
/// 40 MP is ~160 MB of RGBA at decode — survivable — and comfortably above the
/// ~8 MP a 4K screenshot occupies.
pub const MAX_MEDIA_PIXELS: u64 = 40_000_000;

/// The opaque handle a document stores in place of the bytes: `media:{sha256}`.
///
/// A handle, not a URL and not a path: it names content that is already inside
/// this document, so it can never reach the network, the filesystem, or a
/// tracking beacon. Resolution is the host's job.
pub const MEDIA_REF_PREFIX: &str = "media:";

/// What the header of an admitted image says about it. No pixels were read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaHeader {
    /// IANA type for the format the MAGIC BYTES proved — never a filename
    /// extension, and never anything the caller supplied.
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
}

/// Why a candidate was refused. Every variant is a REFUSAL; there is no
/// "accepted with a guess". A malformed or truncated header is rejected rather
/// than defaulted, because the alternative — the shipped `getImageNaturalSize`
/// fallback of `{200, 150}` — silently embedded whatever file the user picked
/// and drew a placeholder over it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaError {
    /// Zero-length file.
    Empty,
    /// Larger than `MAX_MEDIA_BYTES`.
    TooLarge { bytes: usize, limit: usize },
    /// The leading bytes match no format on the allowlist.
    UnknownFormat,
    /// Recognised as SVG, which is refused by policy (see the module header).
    SvgRefused,
    /// Recognised as BMP, which is refused by policy (see the module header).
    BmpRefused,
    /// The magic bytes matched but the header is short, malformed, or
    /// internally inconsistent.
    MalformedHeader { format: &'static str, detail: &'static str },
    /// A dimension is zero, or exceeds `MAX_MEDIA_DIMENSION`.
    DimensionOutOfRange { width: u32, height: u32, limit: u32 },
    /// width * height exceeds `MAX_MEDIA_PIXELS` (decompression bomb).
    TooManyPixels { pixels: u64, limit: u64 },
}

impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MediaError::Empty => write!(f, "The file is empty."),
            MediaError::TooLarge { bytes, limit } => write!(
                f,
                "The image is {} ({} bytes); the limit is {} ({} bytes).",
                human_bytes(*bytes),
                bytes,
                human_bytes(*limit),
                limit
            ),
            MediaError::UnknownFormat => write!(
                f,
                "That file is not a PNG, JPEG, GIF or WebP image. \
                 Only those four formats can be embedded in a document."
            ),
            MediaError::SvgRefused => write!(
                f,
                "SVG images cannot be embedded. An SVG is a script-capable XML \
                 document rather than a picture, so it is not accepted. Export \
                 it as a PNG first."
            ),
            MediaError::BmpRefused => write!(
                f,
                "BMP images cannot be embedded — a BMP is uncompressed and would \
                 bloat the document. Save it as a PNG first."
            ),
            MediaError::MalformedHeader { format, detail } => write!(
                f,
                "This {} file's header is malformed or truncated ({}), so its \
                 size cannot be established. It was not embedded.",
                format, detail
            ),
            MediaError::DimensionOutOfRange { width, height, limit } => write!(
                f,
                "The image is {}x{} pixels; each side must be between 1 and {}.",
                width, height, limit
            ),
            MediaError::TooManyPixels { pixels, limit } => write!(
                f,
                "The image holds {} pixels; the limit is {}. An image this large \
                 would need gigabytes of memory to display.",
                pixels, limit
            ),
        }
    }
}

impl std::error::Error for MediaError {}

impl MediaError {
    /// Is this refusal one where handing the bytes to an image DECODER is
    /// itself the harm, rather than a matter of policy?
    ///
    /// The distinction decides the fate of a legacy inline `data:` payload this
    /// build will not re-admit. Those are deliberately left in place so that a
    /// stricter rule arriving late never destroys a picture the user can see --
    /// but "left in place" means the WebView still decodes it, and for three of
    /// these variants that IS the attack. A 30,000 x 30,000 single-colour PNG is
    /// a few KB on the wire and 3.6 GB of RGBA in the renderer;
    /// `MAX_MEDIA_PIXELS` exists to stop precisely that, and it stops nothing if
    /// the refused bytes are handed to the decoder anyway.
    ///
    ///   * hazard -> the payload must not survive as something renderable
    ///   * policy -> SVG, BMP, an unknown format, a malformed header, an empty
    ///               file. Refused entry to the media store, still safe on screen.
    ///
    /// Exhaustive on purpose: a new variant must be classified here, at the
    /// point where "what does a refusal cost the user" is being decided, rather
    /// than defaulting to whichever answer a wildcard arm happened to give.
    pub fn is_decode_hazard(&self) -> bool {
        match self {
            MediaError::TooLarge { .. }
            | MediaError::DimensionOutOfRange { .. }
            | MediaError::TooManyPixels { .. } => true,
            MediaError::Empty
            | MediaError::UnknownFormat
            | MediaError::SvgRefused
            | MediaError::BmpRefused
            | MediaError::MalformedHeader { .. } => false,
        }
    }
}

fn human_bytes(n: usize) -> String {
    const MIB: usize = 1024 * 1024;
    const KIB: usize = 1024;
    if n >= MIB {
        format!("{:.1} MB", n as f64 / MIB as f64)
    } else if n >= KIB {
        format!("{:.0} KB", n as f64 / KIB as f64)
    } else {
        format!("{} bytes", n)
    }
}

/// THE gate. Prove the format from magic bytes, enforce the byte cap, read the
/// dimensions out of the header, enforce both dimension caps. Nothing is
/// decoded and nothing is allocated beyond the returned struct.
pub fn inspect_media(bytes: &[u8]) -> Result<MediaHeader, MediaError> {
    if bytes.is_empty() {
        return Err(MediaError::Empty);
    }
    // Size first: refusing a 400 MB pick must not depend on parsing it.
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(MediaError::TooLarge {
            bytes: bytes.len(),
            limit: MAX_MEDIA_BYTES,
        });
    }

    let header = if bytes.starts_with(&PNG_MAGIC) {
        parse_png(bytes)?
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        parse_jpeg(bytes)?
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        parse_gif(bytes)?
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        parse_webp(bytes)?
    } else if looks_like_svg(bytes) {
        // Named explicitly rather than folded into UnknownFormat: a user who
        // picked a logo.svg deserves to be told why, and told what to do.
        return Err(MediaError::SvgRefused);
    } else if bytes.starts_with(b"BM") {
        return Err(MediaError::BmpRefused);
    } else {
        return Err(MediaError::UnknownFormat);
    };

    if header.width == 0
        || header.height == 0
        || header.width > MAX_MEDIA_DIMENSION
        || header.height > MAX_MEDIA_DIMENSION
    {
        return Err(MediaError::DimensionOutOfRange {
            width: header.width,
            height: header.height,
            limit: MAX_MEDIA_DIMENSION,
        });
    }
    let pixels = header.width as u64 * header.height as u64;
    if pixels > MAX_MEDIA_PIXELS {
        return Err(MediaError::TooManyPixels {
            pixels,
            limit: MAX_MEDIA_PIXELS,
        });
    }

    Ok(header)
}

// ---------------------------------------------------------------------------
// Per-format header readers. Byte offsets only; no allocation, no decode.
// ---------------------------------------------------------------------------

const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

fn be_u32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn be_u16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}
fn le_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn le_u24(b: &[u8], at: usize) -> u32 {
    u32::from(b[at]) | (u32::from(b[at + 1]) << 8) | (u32::from(b[at + 2]) << 16)
}

fn malformed(format: &'static str, detail: &'static str) -> MediaError {
    MediaError::MalformedHeader { format, detail }
}

/// PNG: the signature MUST be followed immediately by a 13-byte IHDR chunk
/// (spec-mandated first chunk). Width/height are big-endian u32 inside it.
fn parse_png(b: &[u8]) -> Result<MediaHeader, MediaError> {
    if b.len() < 24 {
        return Err(malformed("PNG", "shorter than a PNG signature plus IHDR"));
    }
    if be_u32(b, 8) != 13 {
        return Err(malformed("PNG", "IHDR chunk length is not 13"));
    }
    if &b[12..16] != b"IHDR" {
        return Err(malformed("PNG", "first chunk is not IHDR"));
    }
    Ok(MediaHeader {
        mime_type: "image/png",
        width: be_u32(b, 16),
        height: be_u32(b, 20),
    })
}

/// GIF: fixed logical-screen descriptor right after the 6-byte signature,
/// little-endian u16 width then height.
fn parse_gif(b: &[u8]) -> Result<MediaHeader, MediaError> {
    if b.len() < 10 {
        return Err(malformed("GIF", "shorter than a logical screen descriptor"));
    }
    Ok(MediaHeader {
        mime_type: "image/gif",
        width: u32::from(le_u16(b, 6)),
        height: u32::from(le_u16(b, 8)),
    })
}

/// Is this JPEG marker a Start-Of-Frame? SOF0..SOF15 minus the three markers
/// that share the 0xC0..0xCF range without being frame headers: DHT (0xC4),
/// JPG (0xC8) and DAC (0xCC).
fn is_sof(marker: u8) -> bool {
    (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
}

/// JPEG: dimensions live in the SOFn segment, which is found by walking the
/// marker chain. Each hop is bounds-checked and `i` strictly increases (segment
/// lengths below 2 are rejected), so the walk always terminates.
fn parse_jpeg(b: &[u8]) -> Result<MediaHeader, MediaError> {
    let mut i = 2usize; // past SOI
    loop {
        if i >= b.len() {
            return Err(malformed("JPEG", "no frame header before end of file"));
        }
        if b[i] != 0xFF {
            return Err(malformed("JPEG", "marker chain is broken"));
        }
        // Any number of 0xFF fill bytes may precede the marker id.
        while i < b.len() && b[i] == 0xFF {
            i += 1;
        }
        if i >= b.len() {
            return Err(malformed("JPEG", "file ends inside a marker"));
        }
        let marker = b[i];
        i += 1;

        match marker {
            // Standalone markers with no payload.
            0x01 | 0xD0..=0xD7 => continue,
            // Start of scan: entropy-coded data begins and the dimensions were
            // never declared. Refuse rather than scan compressed data.
            0xDA => return Err(malformed("JPEG", "scan data begins before any frame header")),
            0xD9 => return Err(malformed("JPEG", "end of image before any frame header")),
            _ => {}
        }

        if i + 2 > b.len() {
            return Err(malformed("JPEG", "segment length runs past end of file"));
        }
        let seg_len = be_u16(b, i) as usize;
        if seg_len < 2 {
            return Err(malformed("JPEG", "segment length is below its own minimum"));
        }

        if is_sof(marker) {
            // SOFn payload: [len:2][precision:1][height:2][width:2]
            if i + 7 > b.len() {
                return Err(malformed("JPEG", "frame header is truncated"));
            }
            return Ok(MediaHeader {
                mime_type: "image/jpeg",
                height: u32::from(be_u16(b, i + 3)),
                width: u32::from(be_u16(b, i + 5)),
            });
        }
        i += seg_len;
    }
}

/// WebP: a RIFF container whose FIRST chunk declares the canvas. Three shapes
/// exist and all three are handled — a file carrying only one of them would
/// otherwise be refused for looking malformed.
fn parse_webp(b: &[u8]) -> Result<MediaHeader, MediaError> {
    if b.len() < 20 {
        return Err(malformed("WebP", "shorter than a RIFF chunk header"));
    }
    // The declared RIFF payload must fit in the bytes we hold; a larger claim
    // means the file is truncated.
    let riff_size = le_u32(b, 4) as usize;
    if riff_size + 8 > b.len() {
        return Err(malformed("WebP", "declared RIFF size exceeds the file"));
    }
    match &b[12..16] {
        b"VP8 " => {
            // Lossy: 3-byte frame tag, then the 3-byte key-frame sync code.
            if b.len() < 30 {
                return Err(malformed("WebP", "lossy frame header is truncated"));
            }
            if b[23] != 0x9D || b[24] != 0x01 || b[25] != 0x2A {
                return Err(malformed("WebP", "lossy key-frame sync code is missing"));
            }
            Ok(MediaHeader {
                mime_type: "image/webp",
                width: u32::from(le_u16(b, 26) & 0x3FFF),
                height: u32::from(le_u16(b, 28) & 0x3FFF),
            })
        }
        b"VP8L" => {
            // Lossless: signature byte then 28 bits of packed dimensions.
            if b.len() < 25 {
                return Err(malformed("WebP", "lossless frame header is truncated"));
            }
            if b[20] != 0x2F {
                return Err(malformed("WebP", "lossless signature byte is missing"));
            }
            let packed = le_u32(b, 21);
            Ok(MediaHeader {
                mime_type: "image/webp",
                width: (packed & 0x3FFF) + 1,
                height: ((packed >> 14) & 0x3FFF) + 1,
            })
        }
        b"VP8X" => {
            // Extended (alpha / animation / ICC): the canvas size is authoritative.
            if b.len() < 30 {
                return Err(malformed("WebP", "extended header is truncated"));
            }
            Ok(MediaHeader {
                mime_type: "image/webp",
                width: le_u24(b, 24) + 1,
                height: le_u24(b, 27) + 1,
            })
        }
        _ => Err(malformed("WebP", "unrecognised first chunk")),
    }
}

/// A best-effort SVG sniff, used ONLY to produce a better refusal message.
/// It is not — and cannot be — a validator: SVG has no magic bytes. Anything it
/// misses simply falls through to `UnknownFormat`, which refuses too.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let text = String::from_utf8_lossy(head);
    let lower = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    lower.starts_with("<?xml") || lower.starts_with("<svg") || lower.starts_with("<!doctype svg")
}

// ---------------------------------------------------------------------------
// Media handles
// ---------------------------------------------------------------------------

/// Build the handle a document stores for a hash.
pub fn media_ref(sha256_hex: &str) -> String {
    format!("{}{}", MEDIA_REF_PREFIX, sha256_hex)
}

/// The hash inside a `media:{sha256}` handle, or None if `value` is not one.
///
/// Strict: exactly 64 lowercase hex characters after the prefix. That keeps the
/// handle inert as a path component (the archive stores it as a file NAME) and
/// makes "is this a media handle?" a total function rather than a prefix guess.
pub fn parse_media_ref(value: &str) -> Option<&str> {
    let hash = value.strip_prefix(MEDIA_REF_PREFIX)?;
    if hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        Some(hash)
    } else {
        None
    }
}

/// Is this string a well-formed content hash for the media map?
pub fn is_media_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Walk arbitrary JSON and call `visit` with the hash of every well-formed
/// `media:` handle found — in a string value, or as an object KEY (where a
/// "media -> caption" map would put one).
///
/// ONE implementation, because the two callers must never disagree: the `.cala`
/// save path uses it to decide what to GARBAGE COLLECT and the `.calp` publish
/// path uses it to decide what to SHIP. A publisher-side scan that saw fewer
/// handles than the collector would ship a report with a missing logo; a
/// collector that saw fewer than the publisher would delete bytes still in use.
///
/// The scan is VALUE-shaped, not property-name-shaped. A list of blessed
/// property names would silently orphan a picture the day someone adds a
/// `backgroundImage`.
pub fn visit_media_refs(value: &serde_json::Value, visit: &mut impl FnMut(&str)) {
    match value {
        serde_json::Value::String(s) => {
            if let Some(hash) = parse_media_ref(s) {
                visit(hash);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                visit_media_refs(item, visit);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if let Some(hash) = parse_media_ref(k) {
                    visit(hash);
                }
                visit_media_refs(v, visit);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Legacy data-URL migration
// ---------------------------------------------------------------------------

/// Decode a `data:image/*;base64,...` URL into raw bytes.
///
/// Exists for ONE reason: documents already saved by the shipped, unvalidated
/// Insert > Image path hold whole files base64'd into a control property. Those
/// are real user documents, and they are migrated into `media/` on load. This is
/// NOT an ingress — nothing calls it with anything but bytes already inside a
/// `.cala` the user opened, and the decoded result still goes through
/// `inspect_media` like every other byte.
///
/// Returns None for anything that is not a base64 image data URL; oversize
/// payloads are rejected up front so a 400 MB legacy string never allocates a
/// decode buffer.
pub fn decode_image_data_url(value: &str) -> Option<Vec<u8>> {
    let rest = value.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let meta = &rest[..comma];
    if !meta.starts_with("image/") || !ends_with_base64_tag(meta) {
        return None;
    }
    let payload = &rest[comma + 1..];
    // 4 base64 chars per 3 bytes: refuse before allocating.
    if payload.len() / 4 * 3 > MAX_MEDIA_BYTES {
        return None;
    }
    // PERCENT-DECODE FIRST, because the browser does.
    //
    // The WHATWG data-URL processor percent-decodes the body BEFORE
    // base64-decoding it, so `data:image/png;base64,%69VBORw0KGgo…` is a valid
    // image to WebView2 and was NOT one to this function — `decode_base64`
    // returns None at the first `%`. That disagreement was a security hole, not a
    // cosmetic gap: a payload this host cannot read is a payload it cannot
    // INSPECT, while the renderer decodes it happily. See the `None` arm of
    // `judge_inline_image` for the other half of the fix.
    //
    // It is a no-op for every honest payload: `%` is not in the base64 alphabet,
    // so a string the shipped picker produced passes through unchanged.
    decode_base64(&percent_decode_ascii(payload))
}

/// True when a data-URL media type ends with the `;base64` tag, matched the way
/// the WHATWG data-URL processor matches it: **ASCII case-insensitively**.
///
/// It used to be `meta.ends_with(";base64")` — byte-exact and lowercase-only — in
/// this function and again in the host's `exceeds_byte_cap_encoded`. Both
/// disagreed with the decoder that actually runs, so `data:image/png;BASE64,<4 KB
/// 30000x30000 PNG>` was classified "policy-refused, safe to leave inline" and
/// handed to a renderer that has no caps at all. Two copies of one wrong literal.
pub fn ends_with_base64_tag(meta: &str) -> bool {
    const TAG: &str = ";base64";
    let Some(tail) = meta.get(meta.len().saturating_sub(TAG.len())..) else {
        return false;
    };
    tail.eq_ignore_ascii_case(TAG)
}

/// Percent-decode ASCII escapes, leaving anything malformed exactly as it is.
///
/// Lenient on purpose: browsers leave an invalid `%` sequence literal rather than
/// rejecting the URL, and the point of this function is to agree with the browser
/// about what the bytes are. A sequence left literal simply fails base64 decoding
/// afterwards, which is the conservative outcome.
fn percent_decode_ascii(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string(); // the overwhelmingly common case
    }
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &input[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Standard-alphabet base64 decoder (RFC 4648), whitespace-tolerant.
///
/// Hand-rolled on purpose: it exists solely to read back strings this
/// application itself wrote, and adding a crate to the PRIVILEGED process for
/// forty lines of arithmetic is the wrong trade.
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(input.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = 0usize;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                continue;
            }
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        if padding > 0 {
            // Data after padding is malformed.
            return None;
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    if padding > 2 {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- fixtures: real headers, synthesised byte-exactly ------------------

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut v = PNG_MAGIC.to_vec();
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]); // bit depth, colour type, ...
        v.extend_from_slice(&[0, 0, 0, 0]); // CRC placeholder
        v
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8]; // SOI
        // APP0/JFIF segment, so the walk has to hop at least once.
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        v.extend_from_slice(b"JFIF\0");
        v.extend_from_slice(&[0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
        // SOF0
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        v
    }

    fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&width.to_le_bytes());
        v.extend_from_slice(&height.to_le_bytes());
        v.extend_from_slice(&[0xF7, 0x00, 0x00]);
        v
    }

    fn riff(fourcc: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        let size = 4 + 8 + payload.len();
        v.extend_from_slice(&(size as u32).to_le_bytes());
        v.extend_from_slice(b"WEBP");
        v.extend_from_slice(fourcc);
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(&payload);
        v
    }

    fn webp_lossy(width: u16, height: u16) -> Vec<u8> {
        let mut p = vec![0x00, 0x00, 0x00]; // frame tag (key frame)
        p.extend_from_slice(&[0x9D, 0x01, 0x2A]); // sync code
        p.extend_from_slice(&width.to_le_bytes());
        p.extend_from_slice(&height.to_le_bytes());
        p.extend_from_slice(&[0, 0, 0, 0]);
        riff(b"VP8 ", p)
    }

    fn webp_lossless(width: u32, height: u32) -> Vec<u8> {
        let packed = (width - 1) | ((height - 1) << 14);
        let mut p = vec![0x2F];
        p.extend_from_slice(&packed.to_le_bytes());
        p.extend_from_slice(&[0, 0, 0, 0]);
        riff(b"VP8L", p)
    }

    fn webp_extended(width: u32, height: u32) -> Vec<u8> {
        let mut p = vec![0x00, 0x00, 0x00, 0x00]; // flags + reserved
        let w = width - 1;
        let h = height - 1;
        p.extend_from_slice(&[(w & 0xFF) as u8, ((w >> 8) & 0xFF) as u8, ((w >> 16) & 0xFF) as u8]);
        p.extend_from_slice(&[(h & 0xFF) as u8, ((h >> 8) & 0xFF) as u8, ((h >> 16) & 0xFF) as u8]);
        riff(b"VP8X", p)
    }

    // --- header dimensions, per format -------------------------------------

    #[test]
    fn png_dimensions_come_from_the_ihdr_chunk() {
        let h = inspect_media(&png(640, 480)).expect("valid PNG");
        assert_eq!(h.mime_type, "image/png");
        assert_eq!((h.width, h.height), (640, 480));
    }

    #[test]
    fn jpeg_dimensions_come_from_the_sof_segment_after_a_marker_walk() {
        // The fixture carries an APP0 segment before SOF0, so a parser that
        // read a fixed offset instead of walking would get this wrong.
        let h = inspect_media(&jpeg(1920, 1080)).expect("valid JPEG");
        assert_eq!(h.mime_type, "image/jpeg");
        assert_eq!((h.width, h.height), (1920, 1080));
    }

    #[test]
    fn gif_dimensions_are_little_endian() {
        // 640 = 0x0280: a big-endian misread would give 32770, so this fixture
        // distinguishes the two rather than merely passing.
        let h = inspect_media(&gif(640, 480)).expect("valid GIF");
        assert_eq!(h.mime_type, "image/gif");
        assert_eq!((h.width, h.height), (640, 480));
    }

    #[test]
    fn webp_lossy_lossless_and_extended_all_report_their_canvas() {
        let a = inspect_media(&webp_lossy(800, 600)).expect("lossy WebP");
        assert_eq!((a.mime_type, a.width, a.height), ("image/webp", 800, 600));
        let b = inspect_media(&webp_lossless(800, 600)).expect("lossless WebP");
        assert_eq!((b.mime_type, b.width, b.height), ("image/webp", 800, 600));
        let c = inspect_media(&webp_extended(800, 600)).expect("extended WebP");
        assert_eq!((c.mime_type, c.width, c.height), ("image/webp", 800, 600));
    }

    // --- refusals ----------------------------------------------------------

    #[test]
    fn a_non_image_is_refused_rather_than_given_a_placeholder_size() {
        // The shipped path answered {200, 150} here and embedded the bytes
        // anyway. This is the whole defect, in one assertion.
        let err = inspect_media(b"PK\x03\x04 this is a zip, not a picture").unwrap_err();
        assert_eq!(err, MediaError::UnknownFormat);
    }

    #[test]
    fn an_empty_file_is_refused() {
        assert_eq!(inspect_media(b"").unwrap_err(), MediaError::Empty);
    }

    #[test]
    fn a_file_over_the_byte_cap_is_refused_before_it_is_parsed() {
        let mut big = png(10, 10);
        big.resize(MAX_MEDIA_BYTES + 1, 0);
        match inspect_media(&big).unwrap_err() {
            MediaError::TooLarge { bytes, limit } => {
                assert_eq!(bytes, MAX_MEDIA_BYTES + 1);
                assert_eq!(limit, MAX_MEDIA_BYTES);
            }
            other => panic!("expected TooLarge, got {:?}", other),
        }
        // ...and one byte under the cap is still admitted, so the cap is a
        // boundary rather than a blanket refusal of anything large.
        let mut ok = png(10, 10);
        ok.resize(MAX_MEDIA_BYTES, 0);
        assert!(inspect_media(&ok).is_ok());
    }

    #[test]
    fn a_decompression_bomb_passes_the_byte_cap_and_is_stopped_by_the_pixel_cap() {
        // 30,000 x 30,000: a real single-colour PNG of this size is a few KB,
        // so the byte cap cannot see it. 900 MP of RGBA is 3.6 GB.
        let bomb = png(30_000, 30_000);
        assert!(bomb.len() < MAX_MEDIA_BYTES, "the bomb must be small on disk");
        match inspect_media(&bomb).unwrap_err() {
            MediaError::DimensionOutOfRange { width, height, .. } => {
                assert_eq!((width, height), (30_000, 30_000));
            }
            other => panic!("expected DimensionOutOfRange, got {:?}", other),
        }
        // A bomb that stays under the per-side cap is caught by the pixel cap:
        // 10,000 x 10,000 = 100 MP.
        match inspect_media(&png(10_000, 10_000)).unwrap_err() {
            MediaError::TooManyPixels { pixels, limit } => {
                assert_eq!(pixels, 100_000_000);
                assert_eq!(limit, MAX_MEDIA_PIXELS);
            }
            other => panic!("expected TooManyPixels, got {:?}", other),
        }
    }

    #[test]
    fn a_zero_dimension_is_refused() {
        assert!(matches!(
            inspect_media(&png(0, 10)).unwrap_err(),
            MediaError::DimensionOutOfRange { .. }
        ));
    }

    #[test]
    fn svg_and_bmp_are_refused_by_name() {
        assert_eq!(
            inspect_media(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap_err(),
            MediaError::SvgRefused
        );
        assert_eq!(
            inspect_media(b"<?xml version=\"1.0\"?><svg/>").unwrap_err(),
            MediaError::SvgRefused
        );
        assert_eq!(
            inspect_media(b"BM\x36\x00\x00\x00\x00\x00\x00\x00").unwrap_err(),
            MediaError::BmpRefused
        );
    }

    #[test]
    fn truncated_headers_are_refused_never_guessed() {
        let full = png(100, 100);
        for cut in [8usize, 12, 20, 23] {
            assert!(
                matches!(
                    inspect_media(&full[..cut]).unwrap_err(),
                    MediaError::MalformedHeader { format: "PNG", .. }
                ),
                "PNG truncated to {} bytes must be refused",
                cut
            );
        }
        let j = jpeg(100, 100);
        assert!(matches!(
            inspect_media(&j[..j.len() - 12]).unwrap_err(),
            MediaError::MalformedHeader { format: "JPEG", .. }
        ));
        let g = gif(100, 100);
        assert!(matches!(
            inspect_media(&g[..8]).unwrap_err(),
            MediaError::MalformedHeader { format: "GIF", .. }
        ));
        let w = webp_lossy(100, 100);
        assert!(matches!(
            inspect_media(&w[..22]).unwrap_err(),
            MediaError::MalformedHeader { format: "WebP", .. }
        ));
    }

    #[test]
    fn a_png_signature_over_arbitrary_bytes_is_refused() {
        // Magic bytes alone are not admission: a hostile file can start with
        // any eight bytes it likes.
        let mut fake = PNG_MAGIC.to_vec();
        fake.extend_from_slice(&[0xFF; 64]);
        assert!(matches!(
            inspect_media(&fake).unwrap_err(),
            MediaError::MalformedHeader { format: "PNG", .. }
        ));
    }

    #[test]
    fn a_jpeg_whose_scan_starts_before_any_frame_header_is_refused() {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
        assert!(matches!(
            inspect_media(&v).unwrap_err(),
            MediaError::MalformedHeader { format: "JPEG", .. }
        ));
    }

    #[test]
    fn a_webp_claiming_more_bytes_than_it_holds_is_refused() {
        let mut w = webp_lossy(100, 100);
        // Overstate the RIFF payload size: the file is truncated.
        let huge = (w.len() as u32 + 1000).to_le_bytes();
        w[4..8].copy_from_slice(&huge);
        assert!(matches!(
            inspect_media(&w).unwrap_err(),
            MediaError::MalformedHeader { format: "WebP", .. }
        ));
    }

    // --- handles -----------------------------------------------------------

    #[test]
    fn a_media_handle_round_trips_and_rejects_anything_else() {
        let hash = "a".repeat(64);
        let r = media_ref(&hash);
        assert_eq!(r, format!("media:{}", hash));
        assert_eq!(parse_media_ref(&r), Some(hash.as_str()));

        assert_eq!(parse_media_ref("media:short"), None);
        assert_eq!(parse_media_ref(&format!("media:{}", "A".repeat(64))), None, "uppercase is not the canonical form");
        assert_eq!(parse_media_ref(&format!("media:{}", "../".repeat(21) + "x")), None);
        assert_eq!(parse_media_ref("https://tracker.example/pixel.gif"), None);
        assert_eq!(parse_media_ref("data:image/png;base64,AAAA"), None);
    }

    // --- legacy data URLs ---------------------------------------------------

    #[test]
    fn a_legacy_data_url_decodes_to_the_bytes_it_encoded() {
        let bytes = png(12, 34);
        let b64 = encode_base64_for_test(&bytes);
        let url = format!("data:image/png;base64,{}", b64);
        let decoded = decode_image_data_url(&url).expect("decodes");
        assert_eq!(decoded, bytes);
        let h = inspect_media(&decoded).expect("and still passes the gate");
        assert_eq!((h.width, h.height), (12, 34));
    }

    #[test]
    fn a_non_image_or_oversize_data_url_decodes_to_nothing() {
        assert_eq!(decode_image_data_url("data:text/plain;base64,aGk="), None);
        assert_eq!(decode_image_data_url("data:image/png,notbase64"), None);
        assert_eq!(decode_image_data_url("https://example.com/a.png"), None);
        let oversize = format!("data:image/png;base64,{}", "A".repeat(MAX_MEDIA_BYTES * 2));
        assert_eq!(decode_image_data_url(&oversize), None);
    }

    #[test]
    fn base64_padding_and_whitespace_are_handled_and_junk_is_rejected() {
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("a G k =").unwrap(), b"hi");
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aG!k"), None);
        assert_eq!(decode_base64("aGk=x"), None, "data after padding is malformed");
    }

    fn encode_base64_for_test(bytes: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }
}
