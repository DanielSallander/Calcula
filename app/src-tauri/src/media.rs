//! FILENAME: app/src-tauri/src/media.rs
//! PURPOSE: The host half of embedded binary media — ingress, storage, GC and
//!          migration of the legacy base64 corpus.
//!
//! THE SHAPE OF THE INGRESS, AND WHY IT IS THIS SHAPE
//!
//! Before this module the only picture path in the product was: a hidden
//! `<input type="file">` IN THE WEBVIEW, `FileReader.readAsDataURL` over the
//! whole file, and the resulting base64 string stored verbatim as a control
//! property. Rust never saw a path, there was no size cap, no format check and
//! no dimension check anywhere, and a decode failure fell back to a 200x150
//! placeholder — over bytes that were ALREADY in the document.
//!
//! The replacement inverts every one of those:
//!
//!   * The USER picks the file through the native dialog. The host reads it.
//!   * `calcula_format::media::inspect_media` proves the format from magic
//!     bytes, enforces a byte cap and two dimension caps, and reads the size
//!     out of the header without decoding anything.
//!   * The bytes are filed under their own SHA-256 and NEVER cross IPC. What
//!     comes back is a handle — `media:{sha256}` — plus four integers. A script
//!     that gets hold of the handle can place the picture and can learn how big
//!     it is; it cannot read the bytes, cannot synthesise new ones, and cannot
//!     turn the handle into a URL that leaves the machine.
//!
//! That last property is what makes the handle safe to hand to a restricted
//! script at all, and it is why the return type carries no `data` field. If a
//! future caller "just needs the bytes", it needs a different design, not a
//! field here.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::State;

use calcula_format::media::{
    inspect_media, is_media_hash, media_ref, parse_media_ref, MAX_MEDIA_BYTES,
};
use calp::integrity::sha256_hex;

use crate::controls::{ControlPropertyValue, ControlStorage, MAX_CONTROL_PROPERTY_CHARS};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;

/// Content-addressed media held for the open document: lowercase hex SHA-256 ->
/// raw validated bytes. Mirrors `persistence::Workbook::media`.
pub type MediaStore = HashMap<String, Vec<u8>>;

/// What `read_media_file` hands back. Deliberately four scalars and a handle —
/// see the module header for why there is no `data` field and why there never
/// should be.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    /// The opaque document handle: `media:{sha256}`. Raw identifier so serde's
    /// struct-level camelCase rename emits the key `ref` (verified by test);
    /// `ref` is a Rust keyword, and a per-field `#[serde(rename)]` is banned by
    /// the project's naming rules.
    pub r#ref: String,
    /// IANA type proved by the MAGIC BYTES — never from the file extension.
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u64,
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/// Read an image the user picked, validate it header-only, and file it in the
/// document's media store under its content hash.
///
/// Sibling of `read_text_file` and gated the same way (MAIN window only). The
/// caller supplies a PATH the user chose in the native dialog; it never
/// supplies bytes, so this cannot become "store these arbitrary bytes".
///
/// Order matters and is load-bearing: read, validate, and only THEN construct
/// the `DocumentEffect`. `DocumentEffect::mutates` dirties eagerly, so building
/// it before the gate would mark the document modified for a file that was
/// refused — the gate-then-decide discipline `Persisted<T>` exists to enforce.
#[tauri::command]
pub fn read_media_file(
    state: State<AppState>,
    file_state: State<FileState>,
    window: tauri::Window,
    path: String,
) -> Result<MediaRef, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Refuse on metadata before reading, so a 400 MB pick is not a 400 MB
    // allocation first and a refusal second. The read below re-checks the
    // length it actually got: metadata can lie, and the file can change between
    // the two calls.
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_MEDIA_BYTES as u64 => {
            return Err(format!(
                "The image is {} bytes; the limit is {} bytes.",
                meta.len(),
                MAX_MEDIA_BYTES
            ));
        }
        Ok(_) => {}
        Err(e) => return Err(format!("Failed to read image: {}", e)),
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read image: {}", e))?;
    let header = inspect_media(&bytes).map_err(|e| e.to_string())?;

    let hash = sha256_hex(&bytes);
    let byte_length = bytes.len() as u64;

    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut store = state
            .media
            .write(&effect)
            .map_err(|e| format!("Media store is unavailable: {}", e))?;
        // Content addressing IS the dedup: re-picking the same logo re-uses the
        // entry instead of adding a second copy.
        store.entry(hash.clone()).or_insert(bytes);
    }

    Ok(MediaRef {
        r#ref: media_ref(&hash),
        mime_type: header.mime_type.to_string(),
        width: header.width,
        height: header.height,
        byte_length,
    })
}

/// Resolve a `media:{sha256}` handle to a data URL the WebView can paint.
///
/// This is the ONLY route from a handle back to bytes, and it is a MAIN-window
/// command: the renderer needs pixels, but nothing in the script realm reaches
/// this — the broker's allowlist has no entry for it, and `PRIVILEGED_BACKEND_COMMANDS`
/// denylists it alongside the other host-filesystem doors.
///
/// It re-runs `inspect_media` rather than trusting the stored bytes. Media
/// arriving from a `.calp` was validated at pull, and media in a `.cala` was
/// validated at ingress, but this is the function that decides what the
/// renderer is told a blob IS — so it derives the MIME type from the bytes in
/// front of it every time rather than from anything a caller or a package said.
#[tauri::command]
pub fn resolve_media_ref(state: State<AppState>, media_ref: String) -> Result<String, String> {
    let hash = parse_media_ref(&media_ref)
        .ok_or_else(|| format!("Not a media handle: {}", media_ref))?;
    let store = state
        .media
        .read()
        .map_err(|e| format!("Media store is unavailable: {}", e))?;
    let bytes = store
        .get(hash)
        .ok_or_else(|| format!("This document holds no media {}", hash))?;
    let header = inspect_media(bytes).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        header.mime_type,
        encode_base64(bytes)
    ))
}

/// Standard-alphabet base64 encoder (RFC 4648). Hand-rolled for the same reason
/// the decoder in `calcula_format::media` is: thirty lines of arithmetic is not
/// worth a dependency in the privileged process.
fn encode_base64(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
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

// ---------------------------------------------------------------------------
// Reference scanning + garbage collection
// ---------------------------------------------------------------------------

/// Every media hash the workbook still points at.
///
/// The scan is VALUE-shaped, not key-shaped: it looks for the `media:` handle
/// anywhere in the opaque per-sheet payloads rather than at a list of blessed
/// property names. A property name allowlist would silently orphan a picture the
/// day someone adds a `backgroundImage`; a value scan cannot.
///
/// Every payload that could hold a handle is walked. If a NEW opaque surface is
/// ever added to `Workbook`, it must be added here — `unreferenced_media` is a
/// deleting operation, and the test
/// `every_opaque_workbook_payload_is_scanned_for_media_handles` exists to make
/// that omission fail rather than lose bytes.
pub fn referenced_media_hashes(workbook: &persistence::Workbook) -> HashSet<String> {
    let mut out = HashSet::new();
    for entry in &workbook.controls {
        collect_media_refs(&entry.controls, &mut out);
    }
    for entry in &workbook.cell_types {
        collect_media_refs(&entry.cells, &mut out);
    }
    for entry in &workbook.cell_behaviors {
        collect_media_refs(&entry.binding, &mut out);
    }
    for pc in &workbook.pane_controls {
        collect_media_refs(&pc.config, &mut out);
        collect_media_refs(&pc.value, &mut out);
    }
    for value in workbook.extension_data.values() {
        collect_media_refs(value, &mut out);
    }
    out
}

/// Delegates to `calcula_format::media::visit_media_refs` — the SAME walker the
/// `.calp` publish path uses to decide what to ship. Deliberately not a second
/// implementation: a collector that saw fewer handles than the publisher would
/// delete bytes a package still needs, and one that saw more would leak them.
fn collect_media_refs(value: &serde_json::Value, out: &mut HashSet<String>) {
    calcula_format::media::visit_media_refs(value, &mut |hash| {
        out.insert(hash.to_string());
    });
}

/// GARBAGE COLLECTION, and the decision behind it.
///
/// **What is collected: media no longer referenced, at SAVE time, from the
/// ARCHIVE only.** The in-memory store is never pruned.
///
/// That split is the whole design, and it is what makes undo safe. Deleting a
/// picture removes the control that referenced it; if the bytes went with it,
/// Ctrl+Z would put back a control whose handle resolves to nothing — a broken
/// image that used to work, produced by an operation whose entire promise is
/// that it puts things back. Undo restores control PROPERTIES; it has no
/// knowledge of a media store and should acquire none.
///
/// So: the session keeps every byte it ever admitted, and each save writes only
/// what the document actually points at. Undo can resurrect any reference made
/// during the session and the bytes are still there for the next save. The
/// bytes are finally gone only after a save-and-reload, and a load resets the
/// undo stack — so at no point can undo reach a reference whose bytes were
/// dropped. The cost is bounded by the byte cap times the pictures touched in
/// one session, and it is paid in RAM, not on disk.
pub fn sweep_unreferenced_media(workbook: &mut persistence::Workbook) -> usize {
    let referenced = referenced_media_hashes(workbook);
    let before = workbook.media.len();
    workbook.media.retain(|hash, _| referenced.contains(hash));
    before - workbook.media.len()
}

// ---------------------------------------------------------------------------
// Legacy corpus migration
// ---------------------------------------------------------------------------

/// Outcome of migrating one document's legacy inline images.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaMigration {
    /// Properties rewritten from a data URL to a `media:` handle.
    pub migrated: usize,
    /// Properties that held a data URL this build refuses to admit for a
    /// POLICY reason (SVG, BMP, an unknown format, a malformed header). Left
    /// exactly as they were, and still rendered — see below.
    pub refused: usize,
    /// Properties CLEARED because the payload was refused for a reason that
    /// makes DECODING it the harm: over the byte cap, over a dimension cap, or
    /// over the pixel cap (a decompression bomb). See
    /// `MediaError::is_decode_hazard`.
    ///
    /// Leaving one of these inline was the hole this counter exists to prove
    /// closed. `inspect_media` refused it entry to the media store and the
    /// payload stayed in the control property regardless, so the WebView —
    /// which has no such caps — decoded it anyway. A 30,000 x 30,000 PNG is a
    /// few KB of `controls.json` and 3.6 GB of RGBA in the renderer.
    pub dropped: usize,
    /// Properties CLEARED on a DISTRIBUTED pull because the string was simply too
    /// long — over `MAX_CONTROL_PROPERTY_CHARS`, or over `MAX_MEDIA_BYTES` for a
    /// `data:image/` payload. Always 0 on the `.cala` load path, which
    /// deliberately applies no such ceiling. Open-item 1.6; see
    /// `clamp_oversized_distributed_values` for why the two paths differ.
    pub oversized: usize,
}

/// What should become of one inline `data:image/...` payload.
enum InlineVerdict {
    /// Admissible. These are the decoded bytes; file them and leave a handle.
    Admit(Vec<u8>),
    /// Refused on POLICY. Leave the payload exactly where it is: it is a
    /// picture the user can see, and destroying it because a later build
    /// narrowed the allowlist would be the worse failure.
    LeaveInline,
    /// Refused because DECODING it is the harm. It must not survive as
    /// something renderable, so the property is cleared.
    Drop,
}

/// Judge one inline payload: admit, leave, or drop.
///
/// The one place the "read tolerance, write strictness" rule is actually
/// decided, so the `.cala` corpus and the `.calp` corpus cannot drift on what
/// tolerance means. Tolerance is for pictures a stricter ALLOWLIST now
/// excludes; it was never meant to cover payloads the CAPS exist to stop.
fn judge_inline_image(value: &str) -> InlineVerdict {
    match calcula_format::media::decode_image_data_url(value) {
        Some(bytes) => match inspect_media(&bytes) {
            Ok(_) => InlineVerdict::Admit(bytes),
            Err(err) if err.is_decode_hazard() => InlineVerdict::Drop,
            Err(_) => InlineVerdict::LeaveInline,
        },
        // `decode_image_data_url` returns None for two different situations: a
        // string that is not a base64 image data URL at all, and one whose
        // payload is so large it refuses to allocate a decode buffer. The
        // second is the byte cap speaking, and it is a hazard for exactly the
        // reason `TooLarge` is — the WebView has no such scruple and will
        // decode whatever is left inline. Told apart by the only measure
        // available without decoding: the ENCODED length.
        None if exceeds_byte_cap_encoded(value) => InlineVerdict::Drop,

        // "WE COULD NOT PARSE IT" IS NOT EVIDENCE THAT THE RENDERER CANNOT.
        //
        // This arm used to be a bare `LeaveInline`, and that was the wrong
        // default. Tolerance is for a picture this build can SEE and has decided
        // not to file — a decodable payload whose format the allowlist excludes.
        // It was silently also covering payloads the host could not read AT ALL,
        // and an unreadable payload is an UNINSPECTED one: no byte cap, no
        // dimension cap, no pixel cap has looked at it, while `paintableUrl`
        // hands any non-handle string straight to `img.src`. A 4 KB
        // 30,000 x 30,000 PNG spelled `;BASE64,` or with a percent-escaped body
        // rode through here as "refused on format, safe on screen" and allocated
        // 3.6 GB in the renderer — BUG-0086 again, through a different spelling.
        //
        // So the default inverts: an undecodable payload that DECLARES a raster
        // format is dropped. SVG keeps its tolerance, because it is the one
        // declared type this host never decodes by design (the media module
        // refuses to carry an SVG parser, correctly) and it is the case the
        // corpus actually contains. An SVG that is merely expensive to rasterise
        // remains uncatchable and is a named, accepted limitation.
        None if declares_raster_image(value) => InlineVerdict::Drop,
        None => InlineVerdict::LeaveInline,
    }
}

/// True when a `data:image/...` string declares a RASTER format — i.e. anything
/// this host would normally decode and inspect, as opposed to `image/svg+xml`.
///
/// Deliberately decided on the DECLARED type rather than on content: reaching a
/// verdict is the whole problem here, and the declared type is the only thing
/// available when the payload will not parse.
fn declares_raster_image(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("data:") else {
        return false;
    };
    if !rest.starts_with("image/") {
        return false;
    }
    // The media type is everything up to the comma, or the whole remainder when
    // there is no comma at all — which is itself one of the malformed shapes.
    let meta = match rest.find(',') {
        Some(comma) => &rest[..comma],
        None => rest,
    };
    let subtype = meta["image/".len()..]
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    subtype != "svg+xml" && subtype != "svg"
}

/// True when an inline `data:image/...` payload's own length puts it past the
/// per-image byte budget, so nothing will ever admit it.
///
/// **It used to answer only for `;base64,` payloads and return `false` for every
/// other shape** (open-item 1.6). `decode_image_data_url` returns `None` for a
/// non-base64 or comma-less data URL *without measuring it*, so those two shapes
/// reached `InlineVerdict::LeaveInline` at ANY length: a
/// `data:image/svg+xml,<svg …>` of arbitrary size was copied through untouched.
/// All three shapes are now measured against the same `MAX_MEDIA_BYTES`.
///
/// This is a widening of an EXISTING rule to encodings it was silently skipping,
/// not a new policy — which is why it is safe on the `.cala` load path too, where
/// a genuinely new bound would not be (see open-item 1.6 on why the 64 KiB
/// property cap is applied to distributed payloads ONLY).
fn exceeds_byte_cap_encoded(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("data:") else {
        return false;
    };
    if !rest.starts_with("image/") {
        return false;
    }
    let Some(comma) = rest.find(',') else {
        // No comma at all, so this is not a well-formed data URL and no media
        // type can be parsed out of it. Its LENGTH is real all the same — it is
        // bytes in the document and a string handed to the WebView — and this
        // shape bailed out of both the decoder and the cap before either could
        // measure it.
        return rest.len() > MAX_MEDIA_BYTES;
    };
    let payload = &rest[comma + 1..];
    // `ends_with_base64_tag` rather than a second `ends_with(";base64")` literal.
    // The byte-exact spelling was written out here AND in
    // `decode_image_data_url`, and both disagreed with the browser, which matches
    // the tag case-insensitively — so `;BASE64,` took this function's non-base64
    // branch and a few-KB decompression bomb measured as harmless. One shared
    // predicate now, so the two cannot drift again.
    if calcula_format::media::ends_with_base64_tag(&rest[..comma]) {
        // 4 base64 characters per 3 bytes. Mirrors `decode_image_data_url`'s own
        // pre-allocation refusal rather than re-deriving a second threshold, so
        // the two cannot disagree about which payloads never get decoded.
        return payload.len() / 4 * 3 > MAX_MEDIA_BYTES;
    }
    // Not base64: a literal or percent-encoded payload, where the payload IS the
    // bytes, so its raw length is the measure.
    payload.len() > MAX_MEDIA_BYTES
}

/// The WRITE-door half of `judge_inline_image`: is this property value an
/// inline image payload that must never reach a decoder?
///
/// The migration paths clean the corpus that is ALREADY in a document. This
/// stops a new one being created, which is what makes "no new inline bytes"
/// true of the code rather than only of the design note. It refuses the HAZARD
/// class only — a policy-refused payload (an SVG a legacy document still
/// carries) must round-trip through a property write unharmed, or editing any
/// other property of that control would destroy its picture.
pub fn is_hazardous_inline_image(value: &str) -> bool {
    value.starts_with("data:image/") && matches!(judge_inline_image(value), InlineVerdict::Drop)
}

/// Migrate control properties that still hold a `data:image/*;base64,...` URL
/// into the content-addressed media store, rewriting each to a `media:` handle.
///
/// **The saved corpus is real user data.** Documents produced by the shipped
/// Insert > Image carry whole files base64'd into a control property, and those
/// pictures must keep working. This runs on every `.cala` load, is idempotent
/// (a handle is not a data URL, so a migrated document is a no-op), and does not
/// dirty the document — a user who merely opens a file must not be told it
/// changed.
///
/// A payload this build REFUSES (an SVG, or one over a cap) is left untouched
/// rather than dropped. Deleting it would destroy a picture the user can see;
/// leaving it means the image keeps rendering from its data URL under the
/// existing CSP `img-src ... data:` allowance, while the WRITE door stays shut
/// so no NEW one can be created. Read tolerance and write strictness are
/// different questions and this is deliberately answering them differently.
pub fn migrate_legacy_data_urls(
    controls: &mut ControlStorage,
    media: &mut MediaStore,
) -> MediaMigration {
    let mut report = MediaMigration::default();
    for meta in controls.values_mut() {
        for prop in meta.properties.values_mut() {
            if !prop.value.starts_with("data:image/") {
                continue;
            }
            match judge_inline_image(&prop.value) {
                InlineVerdict::Admit(bytes) => {
                    let hash = sha256_hex(&bytes);
                    media.entry(hash.clone()).or_insert(bytes);
                    *prop = ControlPropertyValue {
                        value_type: prop.value_type.clone(),
                        value: media_ref(&hash),
                    };
                    report.migrated += 1;
                }
                InlineVerdict::LeaveInline => report.refused += 1,
                InlineVerdict::Drop => {
                    // Cleared, not deleted: the control keeps its identity,
                    // geometry and every other property, and paints the honest
                    // "No Image" placeholder. Removing the control instead
                    // would silently change the sheet's layout.
                    prop.value = String::new();
                    report.dropped += 1;
                }
            }
        }
    }
    report
}

/// Rewrite every inline `data:image/*;base64,...` string found ANYWHERE in a
/// JSON payload into a `media:` handle, collecting the decoded bytes.
///
/// VALUE-shaped, not property-name-shaped, for the reason `visit_media_refs`
/// is: a `src` allowlist would silently miss the day someone adds a
/// `backgroundImage`, and here that miss would mean binary staying inline in a
/// document that believes it holds none.
fn rewrite_inline_images(
    value: &mut serde_json::Value,
    out: &mut MediaStore,
    report: &mut MediaMigration,
) {
    match value {
        serde_json::Value::String(text) => {
            if !text.starts_with("data:image/") {
                return;
            }
            match judge_inline_image(text) {
                InlineVerdict::Admit(bytes) => {
                    let hash = sha256_hex(&bytes);
                    out.entry(hash.clone()).or_insert(bytes);
                    *text = media_ref(&hash);
                    report.migrated += 1;
                }
                InlineVerdict::LeaveInline => report.refused += 1,
                InlineVerdict::Drop => {
                    text.clear();
                    report.dropped += 1;
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_inline_images(item, out, report);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                rewrite_inline_images(v, out, report);
            }
        }
        _ => {}
    }
}

/// Clear any string in a DISTRIBUTED payload that exceeds what a locally-created
/// control property is allowed to be (open-item 1.6).
///
/// WHY THE PULL PATH AND NOT THE `.cala` LOAD. A local property write goes
/// through `check_property_value`, which refuses anything over
/// `MAX_CONTROL_PROPERTY_CHARS` (64 KiB). Materialization does NOT — a pull calls
/// `materialize_saved_controls` directly, so that bound never sees a distributed
/// payload, and whatever lands there is written verbatim into the SUBSCRIBER's own
/// `.cala` on their next save. Applying the same cap on the `.cala` load path was
/// considered and REJECTED: a user whose own workbook holds a 90 KiB inline SVG
/// logo — legal, created by the shipped picker, rendering fine today — would lose
/// their picture on the next open, silently.
///
/// On a distributed pull the rule is clean, because this runs AFTER
/// `rewrite_inline_images` has turned every ADMISSIBLE image into a ~70-character
/// `media:` handle. The only value that can still legitimately be large is a
/// policy-refused inline picture, and those are exactly what the two ceilings
/// below are for.
///
/// THE HARM BEING BOUNDED IS PERSISTENCE, NOT EXECUTION. There is no script path
/// here: `onSelect` is stripped, an SVG in an `<img>` is rendered in secure static
/// mode, and the CSP has no `data:` in `script-src`. What was unbounded is the
/// subscriber's DOCUMENT — the media GC prunes the media store, but an inline
/// string is not in the media store, it *is* the document, so nothing ever
/// reclaims it. A durable, silent bloating of the victim's own file, delivered
/// inside a correctly-signed artifact.
///
/// WHY `data:image/` GETS THE LARGER CEILING. A policy-refused picture is a
/// picture the subscriber can see, and BUG-0086's split says those survive. So
/// they are held to the media budget rather than the property budget. Note this
/// closes a gap the recommendation did not state: a base64 payload passes
/// `exceeds_byte_cap_encoded` on its DECODED size, so its ENCODED text could reach
/// 4/3 × `MAX_MEDIA_BYTES` ≈ 10.67 MiB — 171× the property cap — and still be
/// left inline. Measuring the string's own length here is what bounds that.
///
/// WHY IT IS VALUE-SHAPED and visits structural strings too, exactly as
/// `rewrite_inline_images` is: a `properties`-only walk would miss the day someone
/// adds a field, and here that miss is the whole vulnerability. No legitimate
/// `control_type` or `value_type` is 64 KiB long, so clearing one is right.
fn clamp_oversized_distributed_values(
    value: &mut serde_json::Value,
    report: &mut MediaMigration,
) {
    match value {
        serde_json::Value::String(text) => {
            let over = if text.starts_with("data:image/") {
                // Bytes, because bytes are what land in the subscriber's file.
                text.len() > MAX_MEDIA_BYTES
            } else {
                // Characters, to measure it the way the local write door does.
                text.chars().count() > MAX_CONTROL_PROPERTY_CHARS
            };
            if over {
                // Cleared, not removed — matching the established `Drop`
                // treatment, so geometry and identity survive and a picture
                // control paints "No Image" rather than vanishing.
                text.clear();
                report.oversized += 1;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                clamp_oversized_distributed_values(item, report);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                clamp_oversized_distributed_values(v, report);
            }
        }
        _ => {}
    }
}

/// The pure half of `admit_distributed_controls`: sanitize the payload, rewrite
/// its legacy inline images, and bound what is left, returning the rewritten
/// controls, the bytes they now reference, and what happened. No locks, no state
/// — so the admission rules can be tested directly rather than through a live
/// `AppState`.
///
/// ORDER IS LOAD-BEARING. The clamp runs LAST, after inline images have become
/// handles, so an admissible multi-megabyte picture is a short handle by the time
/// the ceilings apply and cannot be destroyed by them.
pub fn migrate_distributed_inline_images(
    saved: &[persistence::SavedSheetControls],
) -> (Vec<persistence::SavedSheetControls>, MediaStore, MediaMigration) {
    let mut admitted = crate::controls::sanitize_distributed_controls(saved);
    let mut bytes = MediaStore::new();
    let mut report = MediaMigration::default();
    for sheet_controls in &mut admitted {
        rewrite_inline_images(&mut sheet_controls.controls, &mut bytes, &mut report);
        clamp_oversized_distributed_values(&mut sheet_controls.controls, &mut report);
    }
    (admitted, bytes, report)
}

/// Admit a DISTRIBUTED control payload into this document: strip executable
/// wiring, then convert any LEGACY inline image into the media store, returning
/// the payload that should actually be materialized.
///
/// **THE ALREADY-PUBLISHED, ALREADY-SIGNED CORPUS.** Packages published before
/// media artifacts existed carry whole images base64'd inside `controls.json`,
/// and that artifact is covered by a DETACHED MANIFEST SIGNATURE. A subscriber
/// cannot re-sign someone else's package and must not be told their working
/// subscription is now invalid, so the pull path READS the old shape — refusing
/// it would break every existing subscription to fix nothing.
///
/// What it does NOT do is let those bytes stay inline. Materialization writes
/// straight into `ControlStorage` (it is not a `set_control_metadata` call, so
/// the 64 KiB property bound never sees it), and whatever lands there is saved
/// verbatim into the SUBSCRIBER's own `controls.json`. Left alone, a legacy pull
/// would be the one surviving route by which unvalidated binary re-enters a
/// document — the exact hole this work closed everywhere else. So the same
/// migration the `.cala` load performs runs here, at the package boundary:
/// decode, re-validate through `inspect_media` (magic bytes, byte cap, both
/// pixel caps), file under the content hash, rewrite the property to a handle.
///
/// The signature is untouched and unaffected: verification happens against the
/// package as published, and this runs AFTER it, on the way into the
/// subscriber's own document — exactly where their own `.cala` corpus is
/// migrated.
///
/// **What the subscriber sees:** the picture, as before. Same pixels, now
/// deduplicated by content and stored as `media/{sha256}` when they save.
///
/// A payload this build refuses (an SVG the old picker accepted, or one over a
/// cap) is LEFT INLINE and counted, never dropped: read tolerance and write
/// strictness are different questions, and deleting it would silently remove a
/// picture the subscriber can see.
///
/// LOCK ORDER: this takes the MEDIA lock and no other. Call it BEFORE taking the
/// controls lock — media-then-controls is the order both pull paths already use
/// (bytes in before the controls that name them), and the inversion would be an
/// AB/BA against it.
pub fn admit_distributed_controls(
    state: &AppState,
    effect: &DocumentEffect,
    saved: &[persistence::SavedSheetControls],
) -> Result<Vec<persistence::SavedSheetControls>, String> {
    let (admitted, bytes, report) = migrate_distributed_inline_images(saved);
    if !bytes.is_empty() {
        // Through the ONE admission point, so package-carried and legacy-inline
        // bytes cannot diverge on what counts as an admissible image.
        merge_pulled_media(state, effect, bytes)?;
    }
    if report.migrated > 0 || report.refused > 0 || report.dropped > 0 || report.oversized > 0 {
        log::info!(
            "[media] distributed controls: migrated {} inline image(s) into the media store; {} refused on format and left inline; {} dropped as unsafe to decode; {} cleared as oversized",
            report.migrated,
            report.refused,
            report.dropped,
            report.oversized
        );
    }
    Ok(admitted)
}

/// Validate media arriving from OUTSIDE this machine (a `.calp` package) before
/// it enters the document, and drop anything that fails.
///
/// A package's artifacts are integrity-checked against a signed manifest, which
/// proves the publisher sent exactly these bytes — it says nothing about whether
/// those bytes are a picture. A subscriber must not be handed a decompression
/// bomb because it was correctly signed. The key is re-derived from the BYTES
/// rather than trusted from the artifact name, so a package cannot file a blob
/// under a hash that is not its own.
///
/// Returns the accepted map and the number of entries rejected.
pub fn admit_foreign_media(incoming: HashMap<String, Vec<u8>>) -> (MediaStore, usize) {
    let mut accepted = MediaStore::new();
    let mut rejected = 0usize;
    for (claimed, bytes) in incoming {
        if !is_media_hash(&claimed) || inspect_media(&bytes).is_err() {
            rejected += 1;
            continue;
        }
        let actual = sha256_hex(&bytes);
        if actual != claimed {
            rejected += 1;
            continue;
        }
        accepted.insert(actual, bytes);
    }
    (accepted, rejected)
}

/// Merge media carried by a pulled `.calp` into the open document's store,
/// after re-validating every blob through `admit_foreign_media`.
///
/// Additive by design: a refresh that replaces a package's controls leaves the
/// old blobs resident, and the save-time sweep drops whatever the document has
/// stopped pointing at. Removing them here instead would mean deciding, mid
/// refresh, that a blob shared with a control the refresh did NOT touch is
/// garbage — which is the reference-counting bug this design exists to avoid.
///
/// Returns (accepted, rejected).
pub fn merge_pulled_media(
    state: &AppState,
    effect: &DocumentEffect,
    incoming: HashMap<String, Vec<u8>>,
) -> Result<(usize, usize), String> {
    if incoming.is_empty() {
        return Ok((0, 0));
    }
    let (accepted, rejected) = admit_foreign_media(incoming);
    let count = accepted.len();
    let mut store = state
        .media
        .write(effect)
        .map_err(|e| format!("Media store is unavailable: {}", e))?;
    for (hash, bytes) in accepted {
        store.entry(hash).or_insert(bytes);
    }
    if rejected > 0 {
        log::warn!(
            "[media] {} package blob(s) refused: not an admissible image, or filed under the wrong hash",
            rejected
        );
    }
    Ok((count, rejected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controls::{ControlMetadata, SavedControlEntry};

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut v: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        v
    }

    fn data_url(bytes: &[u8]) -> String {
        format!("data:image/png;base64,{}", encode_base64(bytes))
    }

    fn control_with(prop: &str, value: &str) -> ControlMetadata {
        let mut properties = HashMap::new();
        properties.insert(
            prop.to_string(),
            ControlPropertyValue { value_type: "static".into(), value: value.into() },
        );
        ControlMetadata { control_type: "image".into(), properties }
    }

    fn workbook_referencing(refs: &[&str]) -> persistence::Workbook {
        let mut wb = persistence::Workbook::new();
        let entries: Vec<SavedControlEntry> = refs
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let mut properties = HashMap::new();
                properties.insert(
                    "src".to_string(),
                    ControlPropertyValue { value_type: "static".into(), value: (*r).into() },
                );
                SavedControlEntry {
                    row: i as u32,
                    col: 0,
                    control_type: "image".into(),
                    properties,
                }
            })
            .collect();
        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: wb.sheets[0].id,
            controls: serde_json::to_value(&entries).unwrap(),
        }];
        wb
    }

    // --- the wire shape ----------------------------------------------------

    #[test]
    fn the_media_ref_serializes_with_the_key_ref_and_carries_no_bytes() {
        let r = MediaRef {
            r#ref: media_ref(&"a".repeat(64)),
            mime_type: "image/png".into(),
            width: 64,
            height: 64,
            byte_length: 1234,
        };
        let v = serde_json::to_value(&r).unwrap();
        let obj = v.as_object().unwrap();
        // The raw identifier must not leak `r#` into the wire format.
        assert!(obj.contains_key("ref"), "got keys: {:?}", obj.keys().collect::<Vec<_>>());
        assert_eq!(obj["mimeType"], "image/png");
        assert_eq!(obj["byteLength"], 1234);
        // The invariant this type exists to hold.
        assert_eq!(obj.len(), 5, "MediaRef must never grow a bytes field");
        for key in ["data", "bytes", "content", "dataUrl", "path"] {
            assert!(!obj.contains_key(key), "MediaRef must not carry {}", key);
        }
    }

    // --- garbage collection -------------------------------------------------

    #[test]
    fn a_save_writes_only_the_media_the_document_still_points_at() {
        let hash_used = sha256_hex(&png_bytes(10, 10));
        let hash_orphan = sha256_hex(&png_bytes(20, 20));
        let mut wb = workbook_referencing(&[&media_ref(&hash_used)]);
        wb.media.insert(hash_used.clone(), png_bytes(10, 10));
        wb.media.insert(hash_orphan.clone(), png_bytes(20, 20));

        let dropped = sweep_unreferenced_media(&mut wb);
        assert_eq!(dropped, 1);
        assert!(wb.media.contains_key(&hash_used));
        assert!(!wb.media.contains_key(&hash_orphan));
    }

    #[test]
    fn the_sweep_touches_the_archive_only_so_undo_can_still_resurrect_a_reference() {
        // The scenario the split exists for: the user deletes the picture, saves,
        // then presses Ctrl+Z. The sweep took the bytes out of the ARCHIVE; the
        // session store still has them, so the restored handle still resolves and
        // the NEXT save writes them back.
        let bytes = png_bytes(10, 10);
        let hash = sha256_hex(&bytes);
        let mut session: MediaStore = MediaStore::new();
        session.insert(hash.clone(), bytes.clone());

        // Save with the picture deleted.
        let mut wb = workbook_referencing(&[]);
        wb.media = session.clone();
        assert_eq!(sweep_unreferenced_media(&mut wb), 1);
        assert!(wb.media.is_empty(), "the archive drops it");
        assert!(session.contains_key(&hash), "the session keeps it");

        // Undo restores the control; the next save carries the bytes again.
        let mut wb2 = workbook_referencing(&[&media_ref(&hash)]);
        wb2.media = session.clone();
        assert_eq!(sweep_unreferenced_media(&mut wb2), 0);
        assert_eq!(wb2.media.get(&hash), Some(&bytes));
    }

    #[test]
    fn every_opaque_workbook_payload_is_scanned_for_media_handles() {
        // The sweep DELETES, so a payload the scan forgets is data loss. Each of
        // these is an independent opaque surface that could carry a handle;
        // dropping one from `referenced_media_hashes` fails here.
        let h = "e".repeat(64);
        let r = media_ref(&h);
        let mut wb = persistence::Workbook::new();
        let sid = wb.sheets[0].id;

        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: sid,
            controls: serde_json::json!([{ "properties": { "src": r } }]),
        }];
        assert!(referenced_media_hashes(&wb).contains(&h), "controls");

        let mut wb = persistence::Workbook::new();
        wb.cell_types = vec![persistence::SavedSheetCellTypes {
            sheet_id: sid,
            cells: serde_json::json!([{ "params": { "icon": r } }]),
        }];
        assert!(referenced_media_hashes(&wb).contains(&h), "cell_types");

        let mut wb = persistence::Workbook::new();
        wb.cell_behaviors = vec![persistence::SavedCellBehavior {
            sheet_id: sid,
            binding: serde_json::json!({ "badge": r }),
        }];
        assert!(referenced_media_hashes(&wb).contains(&h), "cell_behaviors");

        let mut wb = persistence::Workbook::new();
        wb.pane_controls = vec![persistence::SavedPaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Logo".into(),
            control_type: "custom".into(),
            config: serde_json::json!({ "image": r }),
            value: serde_json::Value::Null,
            order: 0,
        }];
        assert!(referenced_media_hashes(&wb).contains(&h), "pane_controls config");

        let mut wb = persistence::Workbook::new();
        wb.extension_data
            .insert("SomeExtension".into(), serde_json::json!({ "logo": r }));
        assert!(referenced_media_hashes(&wb).contains(&h), "extension_data");
    }

    #[test]
    fn the_reference_scan_is_value_shaped_not_property_name_shaped() {
        // A future `backgroundImage` must not be orphaned just because nobody
        // added it to a list. Nesting and object KEYS are covered too.
        let h = "f".repeat(64);
        let r = media_ref(&h);
        let mut wb = persistence::Workbook::new();
        wb.extension_data.insert(
            "Nested".into(),
            serde_json::json!({ "a": [ { "b": { "someFutureProperty": r.clone() } } ] }),
        );
        assert!(referenced_media_hashes(&wb).contains(&h));

        let mut wb = persistence::Workbook::new();
        wb.extension_data
            .insert("KeyedMap".into(), serde_json::json!({ r: "a caption" }));
        assert!(referenced_media_hashes(&wb).contains(&h));
    }

    #[test]
    fn a_url_or_a_malformed_handle_is_not_a_reference() {
        let mut wb = persistence::Workbook::new();
        wb.extension_data.insert(
            "Junk".into(),
            serde_json::json!({
                "a": "https://tracker.example/pixel.gif",
                "b": "media:not-a-hash",
                "c": "media:../../etc/passwd",
            }),
        );
        assert!(referenced_media_hashes(&wb).is_empty());
    }

    // --- legacy migration ---------------------------------------------------

    #[test]
    fn a_legacy_inline_image_becomes_a_handle_and_the_bytes_move_to_the_store() {
        let bytes = png_bytes(64, 48);
        let hash = sha256_hex(&bytes);
        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 1, 1), control_with("src", &data_url(&bytes)));
        let mut media = MediaStore::new();

        let report = migrate_legacy_data_urls(&mut controls, &mut media);
        assert_eq!(report, MediaMigration { migrated: 1, refused: 0, dropped: 0, oversized: 0 });
        assert_eq!(media.get(&hash), Some(&bytes));
        assert_eq!(
            controls[&(0, 1, 1)].properties["src"].value,
            media_ref(&hash),
            "the multi-megabyte string is gone from the control"
        );
    }

    #[test]
    fn migration_is_idempotent_and_dedupes_the_same_picture_across_controls() {
        let bytes = png_bytes(64, 48);
        let hash = sha256_hex(&bytes);
        let url = data_url(&bytes);
        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 1, 1), control_with("src", &url));
        controls.insert((0, 2, 2), control_with("src", &url));
        controls.insert((1, 3, 3), control_with("src", &url));
        let mut media = MediaStore::new();

        let first = migrate_legacy_data_urls(&mut controls, &mut media);
        assert_eq!(first.migrated, 3);
        assert_eq!(media.len(), 1, "one logo on three controls is one blob");

        // Running it again on the already-migrated document changes nothing.
        let second = migrate_legacy_data_urls(&mut controls, &mut media);
        assert_eq!(second, MediaMigration::default());
        assert_eq!(media.len(), 1);
        assert_eq!(controls[&(0, 1, 1)].properties["src"].value, media_ref(&hash));
    }

    #[test]
    fn a_legacy_payload_this_build_refuses_is_left_alone_not_deleted() {
        // An SVG logo the old picker accepted. Refusing to MIGRATE it must not
        // mean destroying a picture the user can see: it keeps rendering from
        // its data URL, while the write door stays shut against new ones.
        let svg = "data:image/svg+xml;base64,PHN2Zy8+";
        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 1, 1), control_with("src", svg));
        let mut media = MediaStore::new();

        let report = migrate_legacy_data_urls(&mut controls, &mut media);
        assert_eq!(report, MediaMigration { migrated: 0, refused: 1, dropped: 0, oversized: 0 });
        assert!(media.is_empty());
        assert_eq!(controls[&(0, 1, 1)].properties["src"].value, svg);
    }

    #[test]
    fn migration_ignores_properties_that_are_not_data_urls() {
        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 1, 1), control_with("text", "Run report"));
        controls.insert((0, 2, 2), control_with("onSelect", "doThing();"));
        let mut media = MediaStore::new();
        assert_eq!(
            migrate_legacy_data_urls(&mut controls, &mut media),
            MediaMigration::default()
        );
        assert_eq!(controls[&(0, 2, 2)].properties["onSelect"].value, "doThing();");
    }

    // --- foreign media ------------------------------------------------------

    #[test]
    fn package_media_is_revalidated_and_rekeyed_from_its_own_bytes() {
        let good = png_bytes(32, 32);
        let good_hash = sha256_hex(&good);
        let mut incoming = HashMap::new();
        incoming.insert(good_hash.clone(), good.clone());
        // A correctly-signed decompression bomb: integrity says yes, the gate
        // says no.
        let bomb = png_bytes(30_000, 30_000);
        incoming.insert(sha256_hex(&bomb), bomb);
        // A blob filed under someone else's hash.
        incoming.insert("0".repeat(64), png_bytes(8, 8));
        // A blob whose key is not a hash at all.
        incoming.insert("../../evil".to_string(), png_bytes(8, 8));

        let (accepted, rejected) = admit_foreign_media(incoming);
        assert_eq!(rejected, 3);
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted.get(&good_hash), Some(&good));
    }

    #[test]
    fn base64_encoding_round_trips_through_the_decoder() {
        for bytes in [vec![], vec![1u8], vec![1, 2], vec![1, 2, 3], png_bytes(7, 9)] {
            let encoded = encode_base64(&bytes);
            let url = format!("data:image/png;base64,{}", encoded);
            assert_eq!(
                calcula_format::media::decode_image_data_url(&url).unwrap_or_default(),
                bytes
            );
        }
    }

    // --- the ALREADY-SAVED .cala corpus, through a real file ----------------

    /// The corpus case end to end: a `.cala` written by the SHIPPED, unvalidated
    /// Insert > Image — whole file base64'd into a control property, no `media/`
    /// section, `format_version` 6 — opened by this build.
    ///
    /// The other migration tests drive `ControlStorage` directly. This one goes
    /// through the file format, because the parts that could go wrong are there:
    /// the archive must still load without a `media/` section, the controls must
    /// still deserialize, and the version chain must not have moved under it.
    #[test]
    fn a_legacy_cala_file_on_disk_still_opens_and_its_picture_survives() {
        let logo = png_bytes(120, 90);
        let hash = sha256_hex(&logo);

        // 1. Write the legacy fixture: inline data URL, empty media map.
        let mut legacy = workbook_referencing(&[&data_url(&logo)]);
        assert!(legacy.media.is_empty(), "the legacy corpus has no media section");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy-picture.cala");
        calcula_format::save_calcula(&legacy, &path).unwrap();

        // The archive it produced declares no `media` feature and stays on the
        // format version every shipped build can already open.
        let raw = std::fs::read(&path).unwrap();
        let manifest = calcula_format::read_calcula_manifest(&raw).unwrap();
        assert!(!manifest.features.contains(&"media".to_string()));
        let legacy_version = manifest.format_version;
        assert_eq!(
            legacy_version,
            calcula_format::CALA_BASE_FORMAT_VERSION,
            "this fixture uses no version-linked feature, so it stamps the base version"
        );

        // 2. Open it the way the load path does: materialize the saved controls,
        //    seed the media store from the archive, then migrate.
        let loaded = calcula_format::load_calcula(&path).unwrap();
        assert!(loaded.media.is_empty(), "nothing to restore — it is all inline");
        let mut controls: ControlStorage = HashMap::new();
        crate::controls::materialize_saved_controls(&loaded.controls, &mut controls, |_| Some(0));
        assert_eq!(controls.len(), 1, "the legacy control survived the round trip");

        let mut media = MediaStore::new();
        let report = migrate_legacy_data_urls(&mut controls, &mut media);

        // 3. The picture is preserved, byte for byte, and no longer inline.
        assert_eq!(report, MediaMigration { migrated: 1, refused: 0, dropped: 0, oversized: 0 });
        assert_eq!(media.get(&hash), Some(&logo));
        let src = &controls[&(0, 0, 0)].properties["src"].value;
        assert_eq!(src, &media_ref(&hash));

        // 4. Saving now writes the bytes as a media artifact — and re-opening
        //    that file is a no-op for the migration, which is what "idempotent"
        //    has to mean across a save boundary rather than just in memory.
        let sheet_ids: Vec<identity::SheetId> = loaded.sheets.iter().map(|s| s.id).collect();
        legacy.controls = crate::controls::collect_controls_for_save(&controls, &sheet_ids);
        legacy.media = media.clone();
        let path2 = dir.path().join("migrated-picture.cala");
        calcula_format::save_calcula(&legacy, &path2).unwrap();

        // THE VERSION CHAIN DID NOT MOVE. Carrying a picture declares the
        // `media` FEATURE so a reader can answer "does this hold binary?" from
        // the manifest alone — but it takes no version link, so this file is
        // still openable by every build that could open the legacy one. A
        // dropped picture is the loudest possible failure; it cannot make the
        // document lie, which is the test the three version-linked sections
        // pass and this one does not.
        let raw2 = std::fs::read(&path2).unwrap();
        let manifest2 = calcula_format::read_calcula_manifest(&raw2).unwrap();
        assert!(manifest2.features.contains(&"media".to_string()));
        assert_eq!(
            manifest2.format_version, legacy_version,
            "media must not raise the format version"
        );

        let reloaded = calcula_format::load_calcula(&path2).unwrap();
        assert_eq!(reloaded.media.get(&hash), Some(&logo), "bytes made it to media/");
        let mut controls2: ControlStorage = HashMap::new();
        crate::controls::materialize_saved_controls(&reloaded.controls, &mut controls2, |_| Some(0));
        let mut media2: MediaStore = reloaded.media.clone().into_iter().collect();
        assert_eq!(
            migrate_legacy_data_urls(&mut controls2, &mut media2),
            MediaMigration::default(),
            "a migrated document migrates again to nothing"
        );
        assert_eq!(&controls2[&(0, 0, 0)].properties["src"].value, &media_ref(&hash));
    }

    // --- the ALREADY-PUBLISHED, ALREADY-SIGNED package corpus --------------

    /// Build a distributed control payload the way a package's `controls.json`
    /// carries one, with arbitrary properties.
    fn distributed_payload(props: &[(&str, &str)]) -> Vec<persistence::SavedSheetControls> {
        let mut properties = HashMap::new();
        for (k, v) in props {
            properties.insert(
                (*k).to_string(),
                ControlPropertyValue { value_type: "static".into(), value: (*v).into() },
            );
        }
        let entry = SavedControlEntry {
            row: 3,
            col: 2,
            control_type: "image".into(),
            properties,
        };
        vec![persistence::SavedSheetControls {
            sheet_id: persistence::Workbook::new().sheets[0].id,
            controls: serde_json::to_value(vec![entry]).unwrap(),
        }]
    }

    fn admitted_value(admitted: &[persistence::SavedSheetControls]) -> String {
        serde_json::to_string(&admitted[0].controls).unwrap()
    }

    #[test]
    fn a_legacy_signed_package_still_shows_its_picture_but_as_a_handle() {
        // The corpus case: published before media artifacts existed, so the
        // image is base64 inside the SIGNED controls.json. The subscriber
        // cannot re-sign it, so the pull must read it — and must not leave the
        // bytes in their own controls.json.
        let logo = png_bytes(64, 64);
        let hash = sha256_hex(&logo);
        let payload = distributed_payload(&[("src", &data_url(&logo))]);

        let (admitted, bytes, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.migrated, 1);
        assert_eq!(report.refused, 0);
        assert_eq!(bytes.get(&hash), Some(&logo), "the picture is preserved byte-for-byte");
        assert!(admitted_value(&admitted).contains(&media_ref(&hash)));
    }

    #[test]
    fn no_legacy_package_payload_reaches_control_storage_as_bytes() {
        // The contract, stated as a test: materialization writes STRAIGHT into
        // ControlStorage — no `set_control_metadata`, so no 64 KiB bound — and
        // whatever lands there is saved verbatim into the subscriber's own
        // controls.json. Nothing that arrives here may still be a data URL.
        let payload = distributed_payload(&[
            ("src", &data_url(&png_bytes(10, 10))),
            ("backgroundImage", &data_url(&png_bytes(11, 11))),
        ]);

        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.migrated, 2, "the scan is value-shaped, not a `src` allowlist");
        assert!(
            !admitted_value(&admitted).contains("data:image/"),
            "an admissible inline image must never survive admission"
        );
    }

    #[test]
    fn a_package_payload_this_build_refuses_stays_inline_so_the_subscriber_keeps_seeing_it() {
        // An SVG the old picker accepted. Refusing the pull would break a
        // working subscription; deleting it would silently remove a picture the
        // subscriber can see. It keeps rendering from its data URL under the
        // CSP `data:` allowance while the write door stays shut.
        let svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
        let payload = distributed_payload(&[("src", svg)]);

        let (admitted, bytes, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.migrated, 0);
        assert_eq!(report.refused, 1);
        assert!(bytes.is_empty());
        assert!(admitted_value(&admitted).contains(svg), "left exactly as it was");
    }

    // --- open-item 1.6: the pull path's unbounded property values ------------
    //
    // Each of these is one of the shapes that was copied through at UNLIMITED
    // length. The harm is PERSISTENCE, not execution: the payload is written
    // verbatim into the subscriber's own `.cala` on their next save, and because
    // an inline string is not in the media store, the media GC never reclaims it.
    // A durable, silent bloating of the victim's file, inside a correctly-signed
    // artifact.

    /// A `data:image/svg+xml,<svg …>` — NOT base64, so `decode_image_data_url`
    /// returned `None` and `exceeds_byte_cap_encoded` returned `false` without
    /// measuring anything. Shape 1 of 3.
    #[test]
    fn a_distributed_non_base64_data_url_over_the_media_cap_is_cleared() {
        let huge = format!("data:image/svg+xml,<svg>{}</svg>", "A".repeat(MAX_MEDIA_BYTES));
        assert!(
            calcula_format::media::decode_image_data_url(&huge).is_none(),
            "precondition: the decoder does not measure this shape at all"
        );
        let payload = distributed_payload(&[("src", &huge)]);

        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        let out = admitted_value(&admitted);
        assert!(!out.contains("<svg>"), "the payload must not survive: {}", &out[..200.min(out.len())]);
        assert!(
            out.len() < 4096,
            "the admitted payload is still {} bytes — it was not bounded",
            out.len()
        );
        // Counted as a decode hazard, because widening `exceeds_byte_cap_encoded`
        // is what catches this one: it is over the MEDIA budget, so it never
        // reaches the property-length ceiling.
        assert_eq!(report.dropped, 1, "report was {:?}", report);
    }

    /// A `data:image/...` string with NO COMMA, which bailed out of the decoder
    /// AND the cap check before either could measure it. Shape 2 of 3.
    #[test]
    fn a_distributed_comma_less_data_url_of_any_length_is_cleared() {
        let huge = format!("data:image/png{}", "A".repeat(MAX_MEDIA_BYTES));
        assert!(!huge.contains(','), "precondition: no comma, so no media type parses");
        let payload = distributed_payload(&[("src", &huge)]);

        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        let out = admitted_value(&admitted);
        assert!(out.len() < 4096, "still {} bytes — not bounded", out.len());
        assert_eq!(report.dropped, 1, "report was {:?}", report);
    }

    /// ANY OTHER PROPERTY — `text`, `tooltip`, an invented key — which the inline
    /// image judgement never examines because it only looks at `data:image/`
    /// strings. Shape 3 of 3, and the one needing no `data:` URL at all.
    ///
    /// Worth stating: a `text` of tens of millions of characters also goes to
    /// `ctx.fillText` on the render thread every frame.
    #[test]
    fn a_distributed_ordinary_property_over_the_char_cap_is_cleared() {
        let huge = "x".repeat(MAX_CONTROL_PROPERTY_CHARS + 1);
        let payload = distributed_payload(&[("text", &huge), ("tooltip", "fine")]);

        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        let out = admitted_value(&admitted);
        assert!(out.len() < 4096, "still {} bytes — not bounded", out.len());
        assert!(out.contains("fine"), "a legal sibling property must survive: {}", out);
        assert_eq!(report.oversized, 1, "report was {:?}", report);
    }

    /// The gap the recommendation did NOT state, found while implementing: a
    /// base64 payload is judged on its DECODED size, so its ENCODED text can
    /// reach 4/3 x MAX_MEDIA_BYTES (~10.67 MiB, 171x the property cap) and still
    /// be "policy-refused, left inline". The string's own length is what bounds it.
    #[test]
    fn a_policy_refused_base64_payload_is_bounded_by_its_encoded_length() {
        // Encoded length just over MAX_MEDIA_BYTES, but a DECODED size under it,
        // so `exceeds_byte_cap_encoded` says no and the format check refuses it
        // on policy — the exact combination that stayed inline.
        let payload_chars = MAX_MEDIA_BYTES + 1024;
        let inline = format!("data:image/gif;base64,{}", "A".repeat(payload_chars));
        assert!(
            !exceeds_byte_cap_encoded(&inline),
            "precondition: the DECODED size is under the media cap, so the byte cap does not fire"
        );
        assert!(
            inline.len() > MAX_MEDIA_BYTES,
            "precondition: but the ENCODED text is over it"
        );
        let payload = distributed_payload(&[("src", &inline)]);

        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        let out = admitted_value(&admitted);
        assert!(
            out.len() < 4096,
            "a {} byte string rode the pull into the subscriber's document",
            out.len()
        );
        assert_eq!(report.oversized, 1, "report was {:?}", report);
    }

    /// PART 1 PINNED WHERE IT IS ACTUALLY LOAD-BEARING — the paths the clamp does
    /// NOT run on.
    ///
    /// Found by reading a sabotage result rather than by writing the test first:
    /// with the widened cap reverted, the two distributed tests above still
    /// bounded their payloads (the clamp caught them) and failed only on WHICH
    /// counter fired. On the pull path the two halves overlap. Part 1 earns its
    /// place on the `.cala` load and at the write door, where nothing else looks,
    /// so that is where it has to be proved.
    #[test]
    fn the_widened_byte_cap_holds_on_the_paths_with_no_clamp() {
        let huge_svg = format!("data:image/svg+xml,<svg>{}</svg>", "A".repeat(MAX_MEDIA_BYTES));
        let huge_comma_less = format!("data:image/png{}", "A".repeat(MAX_MEDIA_BYTES));

        // (a) THE WRITE DOOR. `is_hazardous_inline_image` is what stops a NEW
        //     inline payload being created; before 1.6 it said `false` for both
        //     of these at any size, because the decoder never measured them.
        assert!(
            is_hazardous_inline_image(&huge_svg),
            "an oversized non-base64 data URL must be refused at the write door"
        );
        assert!(
            is_hazardous_inline_image(&huge_comma_less),
            "an oversized comma-less data URL must be refused at the write door"
        );

        // (b) THE `.cala` LOAD PATH, which applies no property ceiling at all —
        //     so if the cap did not catch these, nothing on that path would.
        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 0, 0), control_with("src", &huge_svg));
        controls.insert((0, 0, 1), control_with("src", &huge_comma_less));
        let mut media = MediaStore::new();

        let report = migrate_legacy_data_urls(&mut controls, &mut media);

        assert_eq!(report.dropped, 2, "both are decode hazards by size: {:?}", report);
        assert!(controls[&(0, 0, 0)].properties["src"].value.is_empty());
        assert!(controls[&(0, 0, 1)].properties["src"].value.is_empty());
        assert_eq!(
            report.oversized, 0,
            "and the ceiling is still not applied on the local path"
        );
    }

    // --- the OTHER SPELLINGS of the decode hazard (found by adversarial review) -
    //
    // BUG-0086 fixed the bomb spelled `data:image/png;base64,`. The hazard/policy
    // split is only as good as the agreement between the host's parser and the
    // one that actually runs, and the host's was STRICTER — so every spelling in
    // the gap was classified "policy-refused, safe on screen" and handed to a
    // renderer with no caps. The existing regression test could not see it because
    // its fixture is built by `data_url()`, which is lowercase-only.

    /// A bomb whose base64 tag is spelled in CAPITALS. The WHATWG data-URL
    /// processor matches that tag ASCII case-insensitively; the host required an
    /// exact lowercase `;base64`, in two separate hand-written literals.
    #[test]
    fn a_bomb_spelled_with_an_uppercase_base64_tag_is_dropped() {
        let bomb = png_bytes(30_000, 30_000);
        assert!(
            bomb.len() < 4096,
            "precondition: the bomb is TINY on disk ({} bytes) — size cannot catch it",
            bomb.len()
        );
        let url = format!("data:image/png;BASE64,{}", encode_base64(&bomb));

        // The host can now READ it, which is what lets it JUDGE it.
        assert!(
            calcula_format::media::decode_image_data_url(&url).is_some(),
            "the tag must be matched case-insensitively, as the browser does"
        );
        assert!(
            matches!(judge_inline_image(&url), InlineVerdict::Drop),
            "a 900-megapixel image is a decode hazard however its tag is spelled"
        );
        assert!(is_hazardous_inline_image(&url), "and the write door must refuse it too");

        let payload = distributed_payload(&[("src", &url)]);
        let (admitted, _, report) = migrate_distributed_inline_images(&payload);
        assert_eq!(report.dropped, 1, "report was {:?}", report);
        assert!(!admitted_value(&admitted).contains("BASE64"));
    }

    /// A bomb whose base64 BODY is percent-escaped. This one needs no case
    /// difference at all: it satisfies `ends_with(";base64")`, so the byte cap
    /// measured it as base64 and passed it at 4 KB, while the host's decoder bailed
    /// at the first `%`. Browsers percent-decode the body BEFORE base64-decoding.
    #[test]
    fn a_bomb_with_a_percent_escaped_base64_body_is_dropped() {
        let bomb = png_bytes(30_000, 30_000);
        let b64 = encode_base64(&bomb);
        // Escape the first character, exactly as a hostile publisher would.
        let escaped = format!("%{:02X}{}", b64.as_bytes()[0], &b64[1..]);
        let url = format!("data:image/png;base64,{}", escaped);
        assert!(url.contains('%'), "precondition: the body carries an escape");

        assert!(
            calcula_format::media::decode_image_data_url(&url).is_some(),
            "the host must percent-decode the body the way the browser does"
        );
        assert!(
            matches!(judge_inline_image(&url), InlineVerdict::Drop),
            "and having read it, must recognise the bomb"
        );

        let payload = distributed_payload(&[("src", &url)]);
        let (_, _, report) = migrate_distributed_inline_images(&payload);
        assert_eq!(report.dropped, 1, "report was {:?}", report);
    }

    /// The inverted default: a payload that DECLARES a raster format and cannot be
    /// read at all is dropped, because an uninspected payload is not a safe one.
    /// No cap has looked at it and `paintableUrl` would hand it to `img.src`.
    #[test]
    fn an_undecodable_raster_declaration_is_dropped_not_tolerated() {
        for url in [
            "data:image/png;base64,!!!!not-base64-at-all!!!!",
            "data:image/jpeg,raw-bytes-that-are-not-a-jpeg",
            "data:image/png", // no comma at all
        ] {
            assert!(
                matches!(judge_inline_image(url), InlineVerdict::Drop),
                "{:?} declares a raster format this host cannot inspect, so it must \
                 not be left renderable",
                url
            );
        }

        // AND THE LINE IN THE RIGHT PLACE: an EMPTY payload decodes perfectly well
        // — to zero bytes — so it is an ordinary policy refusal, not an
        // uninspected one. There is nothing for a renderer to decode and nothing
        // to bound. Asserted rather than omitted, because the first version of
        // this test expected a Drop here and the code was right.
        assert!(
            matches!(judge_inline_image("data:image/gif;base64,"), InlineVerdict::LeaveInline),
            "an empty payload was READ successfully; the inverted default is about \
             payloads that could not be read at all"
        );
    }

    /// ...and the tolerance that must SURVIVE the inverted default: SVG is the one
    /// declared type this host never decodes by design, and it is what the corpus
    /// actually contains. Dropping these would destroy pictures users can see.
    #[test]
    fn svg_keeps_its_policy_tolerance_under_the_inverted_default() {
        for url in [
            "data:image/svg+xml,<svg width='4' height='4'/>",
            "data:image/svg+xml;charset=utf-8,<svg/>",
            "data:image/SVG+XML,<svg/>", // declared type is matched case-insensitively
        ] {
            assert!(
                matches!(judge_inline_image(url), InlineVerdict::LeaveInline),
                "{:?} must keep BUG-0086's policy tolerance",
                url
            );
            assert!(!is_hazardous_inline_image(url), "{:?} is not a hazard", url);
        }
    }

    /// A LEGITIMATE uppercase-tag picture must now be ADMITTED, not merely
    /// dropped. Without this, the case-insensitivity fix could "pass" by refusing
    /// everything it newly understands.
    #[test]
    fn a_valid_picture_with_an_uppercase_base64_tag_is_admitted_as_a_handle() {
        let logo = png_bytes(32, 32);
        let hash = sha256_hex(&logo);
        let url = format!("data:image/png;BASE64,{}", encode_base64(&logo));

        let payload = distributed_payload(&[("src", &url)]);
        let (admitted, bytes, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.migrated, 1, "report was {:?}", report);
        assert_eq!(bytes.get(&hash), Some(&logo), "the pixels were filed");
        assert!(admitted_value(&admitted).contains(&media_ref(&hash)));
    }

    /// THE `data:image/` BRANCH OF THE CLAMP, which nothing exercised: a
    /// policy-refused SVG between the property cap (64 KiB) and the media cap
    /// (8 MiB) must SURVIVE a pull. Hold everything to 64 KiB instead and this
    /// picture disappears from a subscriber's report.
    #[test]
    fn a_policy_refused_svg_over_the_property_cap_survives_a_pull() {
        let svg = format!(
            "data:image/svg+xml,<svg>{}</svg>",
            "A".repeat(MAX_CONTROL_PROPERTY_CHARS)
        );
        assert!(svg.len() > MAX_CONTROL_PROPERTY_CHARS, "precondition: over the property cap");
        assert!(svg.len() < MAX_MEDIA_BYTES, "precondition: under the media cap");

        let payload = distributed_payload(&[("src", &svg)]);
        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(
            report.oversized, 0,
            "the data:image/ branch must give a visible picture the LARGER ceiling: {:?}",
            report
        );
        assert_eq!(report.refused, 1, "it is policy-refused and left inline");
        assert!(admitted_value(&admitted).contains("<svg>"), "the picture survived");
    }

    /// THE BOUNDARIES, because both ceilings are `>` and an off-by-one here is a
    /// picture destroyed or a payload admitted.
    ///
    /// Also pins that the rewrite is a pure WIDENING: a differential run over the
    /// old and new bodies agreed on every base64-shaped input, and the two
    /// assertions below are the boundary case from that run.
    #[test]
    fn the_ceilings_are_exclusive_at_exactly_the_cap() {
        // (a) The media cap, non-base64: exactly MAX is allowed, one more is not.
        let head = "data:image/svg+xml,";
        let at = format!("{}{}", head, "A".repeat(MAX_MEDIA_BYTES));
        let over = format!("{}{}", head, "A".repeat(MAX_MEDIA_BYTES + 1));
        assert!(!exceeds_byte_cap_encoded(&at), "exactly at the cap is admissible");
        assert!(exceeds_byte_cap_encoded(&over), "one byte over is not");

        // (b) The property cap, in the distributed clamp: same exclusivity, and
        //     measured in CHARACTERS to match the local write door.
        for (len, expect_cleared) in [
            (MAX_CONTROL_PROPERTY_CHARS, false),
            (MAX_CONTROL_PROPERTY_CHARS + 1, true),
        ] {
            let payload = distributed_payload(&[("text", &"x".repeat(len))]);
            let (_, _, report) = migrate_distributed_inline_images(&payload);
            assert_eq!(
                report.oversized == 1,
                expect_cleared,
                "a {}-char property: expected cleared={}, report {:?}",
                len,
                expect_cleared,
                report
            );
        }

        // (c) `check_property_value` is the local door this cap mirrors. If the two
        //     ever disagree about the boundary, a value legal locally would be
        //     cleared on a pull (or the reverse), so pin them against each other
        //     rather than restating the number.
        assert!(
            crate::controls::check_property_value("text", &"x".repeat(MAX_CONTROL_PROPERTY_CHARS))
                .is_ok(),
            "the local door admits exactly the cap, so the clamp must too"
        );
        assert!(
            crate::controls::check_property_value(
                "text",
                &"x".repeat(MAX_CONTROL_PROPERTY_CHARS + 1)
            )
            .is_err(),
            "the local door refuses one over, so the clamp must too"
        );
    }

    /// A multi-byte property must be measured the way the local door measures it.
    ///
    /// The clamp uses `chars().count()` for ordinary strings and `len()` (bytes)
    /// for `data:image/` ones. That asymmetry is deliberate — bytes are what land
    /// in the subscriber's file, characters are what `check_property_value`
    /// counts — but it means a 3-byte-per-char string is up to 3x its char count
    /// on disk. This records the ACTUAL behaviour so a future reader does not have
    /// to re-derive which measure won where.
    #[test]
    fn a_multibyte_property_is_measured_in_characters_like_the_local_door() {
        // Just under the CHARACTER cap, but ~3x that in bytes.
        let s = "\u{4e00}".repeat(MAX_CONTROL_PROPERTY_CHARS - 1);
        assert!(s.len() > MAX_CONTROL_PROPERTY_CHARS * 2, "precondition: bytes >> chars");
        assert!(
            crate::controls::check_property_value("text", &s).is_ok(),
            "precondition: the LOCAL door admits it, so a pull must not be stricter"
        );

        let payload = distributed_payload(&[("text", &s)]);
        let (_, _, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(
            report.oversized, 0,
            "a value the local door accepts must survive a pull, or the same document \
             is legal when authored and mangled when distributed: {:?}",
            report
        );
    }

    /// A SAFE non-base64 payload must be untouched by the widened cap — the
    /// widening is about SIZE, not about encoding. Without this, part 1 could
    /// pass its tests by refusing every SVG.
    #[test]
    fn a_small_non_base64_data_url_is_still_left_inline() {
        let small = "data:image/svg+xml,<svg width='4' height='4'/>";
        assert!(!exceeds_byte_cap_encoded(small));
        assert!(
            !is_hazardous_inline_image(small),
            "a small SVG is policy-refused, not a hazard — it must round-trip"
        );

        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 0, 0), control_with("src", small));
        let mut media = MediaStore::new();

        let report = migrate_legacy_data_urls(&mut controls, &mut media);

        assert_eq!(controls[&(0, 0, 0)].properties["src"].value, small);
        assert_eq!(report.refused, 1, "left inline on policy: {:?}", report);
        assert_eq!(report.dropped, 0);
    }

    /// THE REGRESSION GUARD FOR THE ORDERING, and the fixture has to be big
    /// enough to actually be one.
    ///
    /// The first version of this test padded to `MAX_CONTROL_PROPERTY_CHARS` and
    /// asserted its precondition against the PROPERTY cap — but the clamp holds
    /// `data:image/` strings to the MEDIA cap, so at 87 KB reversing the order
    /// would have changed nothing and the test's stated failure mode was
    /// unexhibitable. Adversarial review caught that.
    ///
    /// The window that matters is real and narrow: `decode_image_data_url` admits
    /// up to `MAX_MEDIA_BYTES` DECODED, so an admissible picture's data URL runs to
    /// 4/3 of that — 8 to 10.67 MiB — which is OVER the clamp's `data:image/`
    /// ceiling. Only the ordering saves it, and this fixture sits in that window.
    #[test]
    fn a_large_but_admissible_picture_still_arrives_as_a_handle() {
        // `png_bytes` builds a header only (66 chars encoded). Pad it into the
        // 8-10.67 MiB data-URL window: `inspect_media` proves the format from the
        // magic bytes and reads dimensions out of IHDR, so trailing bytes are
        // exactly what a real PNG has.
        let mut logo = png_bytes(400, 400);
        logo.extend(std::iter::repeat(0x5A).take(MAX_MEDIA_BYTES - 1024));
        assert!(
            inspect_media(&logo).is_ok(),
            "precondition: the padded fixture is still an admissible image"
        );
        let hash = sha256_hex(&logo);
        let url = data_url(&logo);
        assert!(
            url.len() > MAX_MEDIA_BYTES,
            "precondition: the data URL ({} bytes) must exceed the clamp's OWN \
             data:image ceiling, or this test cannot detect a reordering",
            url.len()
        );
        let payload = distributed_payload(&[("src", &url)]);

        let (admitted, bytes, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.migrated, 1, "report was {:?}", report);
        assert_eq!(report.oversized, 0, "the clamp must not touch an admitted handle");
        assert_eq!(bytes.get(&hash), Some(&logo), "the pixels arrived");
        assert!(admitted_value(&admitted).contains(&media_ref(&hash)));
    }

    /// The `.cala` load path takes NO property ceiling, deliberately: a user's own
    /// 90 KiB inline SVG logo — legal, created by the shipped picker, rendering
    /// today — must not vanish on the next open. This is the asymmetry open-item
    /// 1.6 chose, so it gets a test rather than a comment.
    #[test]
    fn the_local_cala_path_does_not_apply_the_distributed_property_ceiling() {
        let svg = format!(
            "data:image/svg+xml,<svg>{}</svg>",
            "A".repeat(MAX_CONTROL_PROPERTY_CHARS)
        );
        assert!(svg.len() > MAX_CONTROL_PROPERTY_CHARS);
        assert!(svg.len() < MAX_MEDIA_BYTES, "under the MEDIA cap, so not a hazard");

        let mut controls: ControlStorage = HashMap::new();
        controls.insert((0, 0, 0), control_with("src", &svg));
        let mut media = MediaStore::new();

        let report = migrate_legacy_data_urls(&mut controls, &mut media);

        assert_eq!(
            controls[&(0, 0, 0)].properties["src"].value, svg,
            "the user's own oversized-but-safe picture must survive a local open"
        );
        assert_eq!(report.oversized, 0, "the .cala path applies no ceiling at all");
        assert_eq!(report.refused, 1, "it is refused on FORMAT and left inline");
    }

    #[test]
    fn admission_still_disarms_distributed_onselect() {
        // Migration composes with sanitization rather than replacing it: the
        // pull sites now make ONE call, so this must still hold.
        let payload = distributed_payload(&[
            ("src", &data_url(&png_bytes(8, 8))),
            ("onSelect", "await api.setCellValue('A1', 'pwned')"),
        ]);

        let (admitted, _, _) = migrate_distributed_inline_images(&payload);

        let text = admitted_value(&admitted);
        assert!(!text.contains("onSelect"), "inline script source never materializes");
        assert!(!text.contains("pwned"));
    }

    #[test]
    fn admitting_a_modern_package_changes_nothing_and_is_idempotent() {
        let hash = sha256_hex(&png_bytes(20, 20));
        let payload = distributed_payload(&[("src", &media_ref(&hash))]);

        let (once, bytes, report) = migrate_distributed_inline_images(&payload);
        assert_eq!(report.migrated, 0);
        assert_eq!(report.refused, 0);
        assert!(bytes.is_empty(), "a handle names bytes the package shipped separately");

        let (twice, _, second) = migrate_distributed_inline_images(&once);
        assert_eq!(second, MediaMigration::default());
        assert_eq!(admitted_value(&once), admitted_value(&twice));
    }

    #[test]
    fn a_correctly_signed_decompression_bomb_inline_is_refused_not_admitted() {
        // The signature proves the publisher sent these bytes, not that they
        // are a picture. A 30k x 30k single-colour PNG is a few KB inline and
        // 3.6 GB of RGBA at decode — the pixel cap, not the byte cap, catches
        // it, and the same gate has to apply to the inline shape.
        //
        // THIS TEST USED TO STOP AT `bytes.is_empty()`, and its name has always
        // claimed more than that checked. Keeping the bomb out of the media
        // store is not the same statement as refusing it: the payload stayed in
        // the control property, materialized straight into the subscriber's own
        // `controls.json`, and was handed to the WebView as
        // `<img src="data:...">` — which is the one component with no caps at
        // all. The store was clean and the renderer still got the bomb.
        let bomb = png_bytes(30_000, 30_000);
        let payload = distributed_payload(&[("src", &data_url(&bomb))]);

        let (admitted, bytes, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.migrated, 0);
        assert_eq!(report.refused, 0, "a bomb is not a format refusal");
        assert_eq!(report.dropped, 1);
        assert!(bytes.is_empty(), "a bomb never enters the media store");
        assert!(
            !admitted_value(&admitted).contains("data:image/"),
            "and it never reaches the renderer either"
        );
    }

    // --- refusal must be COMPLETE, not merely bookkeeping ------------------

    #[test]
    fn an_inline_bomb_in_a_local_cala_is_cleared_rather_than_left_to_the_renderer() {
        // The `.cala` corpus takes the same rule as the package corpus. The
        // migration's tolerance exists for pictures a narrowed ALLOWLIST now
        // excludes — never for payloads the CAPS exist to stop.
        let mut controls = ControlStorage::new();
        controls.insert(
            (0, 1, 1),
            control_with("src", &data_url(&png_bytes(30_000, 30_000))),
        );
        let mut media = MediaStore::new();

        let report = migrate_legacy_data_urls(&mut controls, &mut media);

        assert_eq!(report.dropped, 1);
        assert_eq!(report.migrated, 0);
        assert!(media.is_empty());
        let value = &controls[&(0, 1, 1)].properties["src"].value;
        assert_eq!(value, "", "cleared, so the control paints \"No Image\"");
    }

    #[test]
    fn a_bomb_that_is_merely_too_wide_is_dropped_on_the_dimension_cap_too() {
        // `DimensionOutOfRange` and `TooManyPixels` are different refusals and
        // both are hazards: 40,000 x 4 is inside the pixel cap and outside the
        // dimension cap, and it still asks the decoder for a 40,000-px scanline.
        let payload = distributed_payload(&[("src", &data_url(&png_bytes(40_000, 4)))]);

        let (admitted, _, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.dropped, 1);
        assert!(!admitted_value(&admitted).contains("data:image/"));
    }

    #[test]
    fn an_inline_payload_too_large_to_even_decode_is_dropped_not_left_inline() {
        // The inverted control. `decode_image_data_url` refuses to allocate a
        // buffer for anything over the byte cap and returns None — and the old
        // code read None as "leave it alone". So the BIGGER the payload, the
        // more certainly it survived: the cap meant to stop large payloads was
        // the very thing that waved them through, unbounded and unvalidated,
        // into the subscriber's saved document.
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_MEDIA_BYTES * 2));
        let payload = distributed_payload(&[("src", &huge)]);

        let (admitted, bytes, report) = migrate_distributed_inline_images(&payload);

        assert_eq!(report.dropped, 1);
        assert_eq!(report.refused, 0);
        assert!(bytes.is_empty());
        let text = admitted_value(&admitted);
        assert!(!text.contains("data:image/"));
        assert!(
            text.len() < 500,
            "the unbounded string must not survive into controls.json (was {})",
            text.len()
        );
    }

    #[test]
    fn a_format_refusal_is_still_tolerated_because_it_is_safe_to_render() {
        // The other half of the rule, pinned so a later tightening cannot
        // quietly turn every refusal into data loss. An SVG the old picker
        // accepted is a real picture, it is small, and an <img> will not run
        // its script — so it stays, exactly as before.
        for safe in [
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            "data:image/bmp;base64,Qk0AAAAA",
        ] {
            let payload = distributed_payload(&[("src", safe)]);
            let (admitted, _, report) = migrate_distributed_inline_images(&payload);
            assert_eq!(report.dropped, 0, "{} must not be dropped", safe);
            assert_eq!(report.refused, 1, "{} is a format refusal", safe);
            assert!(admitted_value(&admitted).contains(safe), "left exactly as it was");
        }
    }

    #[test]
    fn every_media_error_is_classified_as_hazard_or_policy_on_purpose() {
        // `is_decode_hazard` matches exhaustively, so a NEW variant is a compile
        // error rather than a silent default. This pins the classification
        // itself: the three caps are hazards, and everything that is merely a
        // statement about FORMAT is not.
        use calcula_format::media::MediaError;
        assert!(MediaError::TooLarge { bytes: 1, limit: 0 }.is_decode_hazard());
        assert!(MediaError::TooManyPixels { pixels: 1, limit: 0 }.is_decode_hazard());
        assert!(MediaError::DimensionOutOfRange { width: 1, height: 1, limit: 0 }
            .is_decode_hazard());
        assert!(!MediaError::SvgRefused.is_decode_hazard());
        assert!(!MediaError::BmpRefused.is_decode_hazard());
        assert!(!MediaError::UnknownFormat.is_decode_hazard());
        assert!(!MediaError::Empty.is_decode_hazard());
        assert!(!MediaError::MalformedHeader { format: "PNG", detail: "short" }
            .is_decode_hazard());
    }
}
