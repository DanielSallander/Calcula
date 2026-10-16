//! FILENAME: app/src-tauri/src/object_bindings/page_overrides.rs
// PURPOSE: A Page Navigator's PER-BUTTON bindings (D §3.18a, WP-D S8d): one
//          page's caption, "hidden" flag or colours bound to a formula, at
//          `/properties/pageOverrides/<page key>/<field>`.
// CONTEXT: A navigator keeps its per-page settings in ONE control property,
//          `pageOverrides` -- a JSON array whose canonical bytes are WP-B's
//          (`calcula_format::page_navigator`, byte-identical to the frontend's
//          `serializePageNavigatorOverrides`). No pointer can address one entry
//          of that string, and an INDEX into the parsed array would re-aim at
//          another page's entry the moment one is added or removed. So the
//          binding address is keyed by PAGE (B-navigator.md C5):
//            page key  the page's SheetId, or `name:<sheet name>` for an entry
//                      that names no id (= the frontend's `navigatorItemKey`)
//            field     text | hidden | fill | color | borderColor
//          and this module is everything that turns that address back into the
//          one string the painter reads:
//            * the AI-visible projection (`project_overrides`): the array as an
//              OBJECT keyed by page key, so the pointer has something to point at;
//            * the literal write (`upsert_literal`): parse, upsert ONE page's
//              entry by the frontend's own matching rule, re-serialise
//              canonically -- every other entry keeps its bytes;
//            * the overlay (`overlay_overrides`): the painter keeps reading one
//              string, so `controls::resolve_control_properties_core` patches the
//              bound fields into it here, in Rust (RULINGS R7: no TS overlay);
//            * DORMANT (`ReportPages::resolve`): a binding whose page key names no
//              live report page resolves to nothing -- no paint, no error -- and
//              is KEPT, so an undo that brings the page back brings the binding
//              back with it.
//
//          THE ONE MATCHING RULE is the frontend's `matchPageNavigatorOverride`
//          (app/src/api/buttonControlService.ts): the entry whose sheetId is the
//          page's id; else an entry whose id names NO live page and whose
//          sheetName is the page's name; else the same, case-folded. Painter,
//          pane and this module must pick the same entry, or a bound caption
//          would land on an entry the painter never reads.
//
// LOCKS: `ReportPages::read` and `check_binding_target` take each store they
//        read and release it before the next; nothing here touches the binding
//        store or its runtime.

use std::collections::HashSet;

use calcula_format::page_navigator::{
    parse_page_overrides, serialize_page_overrides, PageOverrideWire, PAGE_NAVIGATOR_CONTROL_TYPE,
    PAGE_NAVIGATOR_OVERRIDES_PROPERTY,
};
use serde_json::{json, Map, Value};

use crate::api_types::{ObjectBindingKind, ObjectBindingRef, ResolvedBinding};
use crate::AppState;

use super::catalog;

/// Most entries one navigator keeps (frontend `MAX_PAGE_NAVIGATOR_OVERRIDES`).
pub const MAX_PAGE_NAVIGATOR_OVERRIDES: usize = 256;
/// Longest caption (frontend `MAX_PAGE_NAVIGATOR_CAPTION`).
pub const MAX_PAGE_NAVIGATOR_CAPTION: usize = 255;
/// The prefix of a page key that names a page by its NAME (an entry with no id).
pub const PAGE_NAME_KEY_PREFIX: &str = "name:";
/// The fields one page's entry may carry, besides the two that NAME the page.
pub const PAGE_OVERRIDE_FIELDS: &[&str] = &["text", "hidden", "fill", "color", "borderColor"];
/// The two fields that name the page an entry is about: identity, never bound.
pub const PAGE_OVERRIDE_IDENTITY_FIELDS: &[&str] = &["sheetId", "sheetName"];

/// A per-button binding address, unescaped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerButtonPath {
    /// A SheetId, or `name:<sheet name>`.
    pub page_key: String,
    /// One of [`PAGE_OVERRIDE_FIELDS`] (unchecked here; the catalog checks it).
    pub field: String,
}

/// The page key and field of `/properties/pageOverrides/<key>/<field>`, or
/// `None` for any other path.
pub fn per_button_path(path: &str) -> Option<PerButtonPath> {
    let escaped = catalog::pointer_segments(path).ok()?;
    if escaped.len() != 4 {
        return None;
    }
    let segments: Vec<String> = escaped
        .iter()
        .map(|s| catalog::unescape_segment(s))
        .collect::<Option<Vec<String>>>()?;
    if segments[0] != "properties" || segments[1] != PAGE_NAVIGATOR_OVERRIDES_PROPERTY {
        return None;
    }
    Some(PerButtonPath { page_key: segments[2].clone(), field: segments[3].clone() })
}

/// The pointer of one page's field (the page key RFC 6901-escaped).
pub fn per_button_pointer(page_key: &str, field: &str) -> String {
    format!(
        "/properties/{}/{}/{}",
        PAGE_NAVIGATOR_OVERRIDES_PROPERTY,
        catalog::escape_segment(page_key),
        catalog::escape_segment(field)
    )
}

/// The page key an entry is addressed by (= the frontend's `navigatorItemKey`).
pub fn page_key_of(entry: &PageOverrideWire) -> String {
    if entry.sheet_id.is_empty() {
        format!("{PAGE_NAME_KEY_PREFIX}{}", entry.sheet_name)
    } else {
        entry.sheet_id.clone()
    }
}

// ---------------------------------------------------------------------------
// The live report pages
// ---------------------------------------------------------------------------

/// One report page (a canvas sheet) as a navigator lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LivePage {
    /// `SheetId::to_string()`.
    pub sheet_id: String,
    /// The tab's name now.
    pub name: String,
}

/// The workbook's report pages, in tab order -- the frontend's
/// `@api/reportPages` list, read from the Rust sheet table.
#[derive(Debug, Clone, Default)]
pub struct ReportPages {
    pages: Vec<LivePage>,
}

impl ReportPages {
    /// Copy the sheet table out (ids, names, kinds), each lock released.
    pub fn read(state: &AppState) -> ReportPages {
        let ids = state.sheet_ids.read().map(|g| g.clone()).unwrap_or_default();
        let names = state.sheet_names.read().map(|g| g.clone()).unwrap_or_default();
        let kinds = state.sheet_kinds.read().map(|g| g.clone()).unwrap_or_default();
        ReportPages::from_table(&ids, &names, &kinds)
    }

    /// From a copied sheet table: every canvas sheet with an id and a name.
    pub fn from_table(
        ids: &[identity::SheetId],
        names: &[String],
        kinds: &[::persistence::SheetKind],
    ) -> ReportPages {
        let pages = kinds
            .iter()
            .enumerate()
            .filter(|(_, kind)| kind.is_canvas())
            .filter_map(|(i, _)| {
                Some(LivePage { sheet_id: ids.get(i)?.to_string(), name: names.get(i)?.clone() })
            })
            .collect();
        ReportPages { pages }
    }

    /// The live page a page key names, or `None` -- the DORMANT case. An id key
    /// names the page with that id; a `name:` key the page of that name (exact,
    /// then case-folded, as sheet names compare).
    pub fn resolve(&self, page_key: &str) -> Option<&LivePage> {
        match page_key.strip_prefix(PAGE_NAME_KEY_PREFIX) {
            Some(name) => self
                .pages
                .iter()
                .find(|p| p.name == name)
                .or_else(|| {
                    let folded = name.to_lowercase();
                    self.pages.iter().find(|p| p.name.to_lowercase() == folded)
                }),
            None => self.pages.iter().find(|p| p.sheet_id == page_key),
        }
    }

    fn live_ids(&self) -> HashSet<&str> {
        self.pages.iter().map(|p| p.sheet_id.as_str()).collect()
    }
}

/// THE ONE MATCHING RULE (frontend `matchPageNavigatorOverride`): the index of
/// the entry that applies to `page`, or `None`.
pub fn match_entry(list: &[PageOverrideWire], page: &LivePage, pages: &ReportPages) -> Option<usize> {
    if !page.sheet_id.is_empty() {
        if let Some(i) = list.iter().position(|o| o.sheet_id == page.sheet_id) {
            return Some(i);
        }
    }
    let live = pages.live_ids();
    let orphan = |o: &PageOverrideWire| o.sheet_id.is_empty() || !live.contains(o.sheet_id.as_str());
    if let Some(i) = list.iter().position(|o| orphan(o) && o.sheet_name == page.name) {
        return Some(i);
    }
    let folded = page.name.to_lowercase();
    list.iter().position(|o| orphan(o) && o.sheet_name.to_lowercase() == folded)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// A colour as an override stores it (`#rgb`, `#rrggbb` or `#rrggbbaa`, the
/// frontend's PAGE_NAVIGATOR_COLOR), or `None`. A bound colour may also arrive
/// as `rgb(r, g, b)` / `rgba(r, g, b, a)` (the binding colour type): it is
/// converted, since the painter's parse drops anything that is not hex.
pub fn navigator_colour(raw: &str) -> Option<String> {
    let s = raw.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return (matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| s.to_string());
    }
    let lower = s.to_ascii_lowercase();
    let (body, want) = if let Some(b) = lower.strip_prefix("rgba(") {
        (b, 4)
    } else if let Some(b) = lower.strip_prefix("rgb(") {
        (b, 3)
    } else {
        return None;
    };
    let parts: Vec<&str> = body.strip_suffix(')')?.split(',').map(str::trim).collect();
    if parts.len() != want {
        return None;
    }
    let mut out = String::from("#");
    for p in &parts[..3] {
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out.push_str(&format!("{n:02x}"));
    }
    if want == 4 {
        let a: f64 = parts[3].parse().ok()?;
        if !(0.0..=1.0).contains(&a) {
            return None;
        }
        out.push_str(&format!("{:02x}", (a * 255.0).round() as u8));
    }
    Some(out)
}

/// `s` cut to at most `max` characters.
fn clip_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Set (or clear) ONE field of `entry` from a JSON value.
///
/// Clearing follows the pane (`applyPageOverrideEdit`): an empty caption and
/// an empty colour are REMOVED, and `hidden` is kept only when true. `strict`
/// (a literal write) refuses what does not fit with a sentence; non-strict
/// (the paint overlay) clips a long caption and reports a bad value as `Err`
/// for the caller to skip.
pub fn set_field(entry: &mut PageOverrideWire, field: &str, value: &Value, strict: bool) -> Result<(), String> {
    match field {
        "text" => {
            let text = match value {
                Value::Null => None,
                Value::String(s) if s.is_empty() => None,
                Value::String(s) => {
                    let n = s.chars().count();
                    if n > MAX_PAGE_NAVIGATOR_CAPTION && strict {
                        return Err(format!(
                            "A page button's caption is at most {MAX_PAGE_NAVIGATOR_CAPTION} characters; this one is {n}."
                        ));
                    }
                    Some(clip_chars(s, MAX_PAGE_NAVIGATOR_CAPTION))
                }
                other if !strict => Some(clip_chars(
                    &super::literal::control_property_string(other),
                    MAX_PAGE_NAVIGATOR_CAPTION,
                )),
                _ => return Err("A page button's caption must be text.".to_string()),
            };
            entry.text = text;
        }
        "hidden" => {
            entry.hidden = match value {
                Value::Bool(true) => Some(true),
                Value::Bool(false) | Value::Null => None,
                _ => return Err("A page button's 'hidden' setting must be TRUE or FALSE.".to_string()),
            };
        }
        "fill" | "color" | "borderColor" => {
            let colour = match value {
                Value::Null => None,
                Value::String(s) if s.trim().is_empty() => None,
                Value::String(s) => Some(navigator_colour(s).ok_or_else(|| {
                    format!("'{s}' is not a colour a page button can use: write #rgb, #rrggbb, #rrggbbaa or rgb(r, g, b).")
                })?),
                _ => return Err(format!("A page button's {field} must be a colour such as #1F77B4.")),
            };
            match field {
                "fill" => entry.fill = colour,
                "color" => entry.color = colour,
                _ => entry.border_color = colour,
            }
        }
        other => {
            return Err(format!(
                "'{other}' is not a page button setting; the settings are {}.",
                PAGE_OVERRIDE_FIELDS.join(", ")
            ))
        }
    }
    Ok(())
}

/// Does `entry` carry no setting at all (only the page's id and name)?
fn entry_is_empty(entry: &PageOverrideWire) -> bool {
    entry.text.is_none()
        && entry.hidden.is_none()
        && entry.fill.is_none()
        && entry.color.is_none()
        && entry.border_color.is_none()
}

/// A new entry for `page` addressed by `page_key` (an id key names the page by
/// its id AND current name; a `name:` key by its name only).
fn new_entry(page_key: &str, page: &LivePage) -> PageOverrideWire {
    let sheet_id = if page_key.starts_with(PAGE_NAME_KEY_PREFIX) { String::new() } else { page.sheet_id.clone() };
    PageOverrideWire {
        sheet_id,
        sheet_name: page.name.clone(),
        text: None,
        hidden: None,
        fill: None,
        color: None,
        border_color: None,
    }
}

/// The stored list, or `None` when the stored value cannot be read (blank is
/// the empty list).
fn parse_stored(raw: &str) -> Option<Vec<PageOverrideWire>> {
    if raw.trim().is_empty() {
        return Some(Vec::new());
    }
    parse_page_overrides(raw)
}

// ---------------------------------------------------------------------------
// The projection, the literal write, the overlay
// ---------------------------------------------------------------------------

/// The AI-visible JSON of a navigator's `pageOverrides`: an OBJECT keyed by
/// page key, each value `{sheetName, text?, hidden?, fill?, color?, borderColor?}`.
/// `None` when the stored value cannot be read (the projection then keeps the
/// string, like any other property). Two entries with one key: the first wins,
/// as it does for the painter.
pub fn project_overrides(raw: &str) -> Option<Value> {
    let list = parse_stored(raw)?;
    let mut out = Map::new();
    for entry in &list {
        let key = page_key_of(entry);
        if out.contains_key(&key) {
            continue;
        }
        let mut value = Map::new();
        value.insert("sheetName".to_string(), Value::String(entry.sheet_name.clone()));
        if let Some(text) = &entry.text {
            value.insert("text".to_string(), Value::String(text.clone()));
        }
        if let Some(hidden) = entry.hidden {
            value.insert("hidden".to_string(), Value::Bool(hidden));
        }
        for (name, colour) in [("fill", &entry.fill), ("color", &entry.color), ("borderColor", &entry.border_color)] {
            if let Some(c) = colour {
                value.insert(name.to_string(), json!(c));
            }
        }
        out.insert(key, Value::Object(value));
    }
    Some(Value::Object(out))
}

/// The `pageOverrides` value after a LITERAL write of one page's `field`:
/// `Ok(None)` when nothing changes, `Ok(Some(next))` with the canonical bytes
/// otherwise. The page's entry is found by the one matching rule, named by its
/// id AND current name, and removed when its last setting is cleared (the
/// pane's rule); every other entry keeps its bytes and its place.
pub fn upsert_literal(
    raw: &str,
    page_key: &str,
    field: &str,
    value: &Value,
    pages: &ReportPages,
) -> Result<Option<String>, String> {
    let page = pages.resolve(page_key).ok_or_else(|| no_page_sentence(page_key))?;
    let mut list = parse_stored(raw).ok_or_else(|| {
        "This navigator's page button settings cannot be read, so one button's setting cannot be changed. \
         Reset them in the Properties pane's Buttons section first."
            .to_string()
    })?;
    let at = match_entry(&list, page, pages);
    let mut entry = match at {
        Some(i) => {
            let mut e = list[i].clone();
            let fresh = new_entry(page_key, page);
            e.sheet_id = fresh.sheet_id;
            e.sheet_name = fresh.sheet_name;
            e
        }
        None => new_entry(page_key, page),
    };
    set_field(&mut entry, field, value, true)?;
    match at {
        Some(i) if entry_is_empty(&entry) => {
            list.remove(i);
        }
        Some(i) => list[i] = entry,
        None if entry_is_empty(&entry) => return Ok(None),
        None => {
            if list.len() >= MAX_PAGE_NAVIGATOR_OVERRIDES {
                return Err(format!(
                    "This navigator already keeps settings for {MAX_PAGE_NAVIGATOR_OVERRIDES} pages, the most it can; \
                     clear settings you no longer need first."
                ));
            }
            list.push(entry);
        }
    }
    let next = serialize_page_overrides(&list);
    if next == raw {
        return Ok(None);
    }
    let n = next.chars().count();
    if n > crate::controls::MAX_CONTROL_PROPERTY_CHARS {
        return Err(format!(
            "The per-page button settings would be {n} characters; the limit is {}. \
             Shorten some captions or clear settings you no longer need.",
            crate::controls::MAX_CONTROL_PROPERTY_CHARS
        ));
    }
    Ok(Some(next))
}

/// What a resolved per-button binding paints as, or `None` to keep the
/// literal: PENDING keeps it; an ERROR keeps it except on the caption, which
/// shows the error display like any text property; a dormant or empty value
/// (null) keeps it.
fn overlay_value(value: &ResolvedBinding, field: &str) -> Option<Value> {
    if value.pending {
        return None;
    }
    if value.error.is_some() {
        return (field == "text").then(|| Value::String(value.display.clone()));
    }
    match &value.value {
        Value::Null => None,
        other => Some(other.clone()),
    }
}

/// The `pageOverrides` string the painter is handed: `raw` with every bound
/// per-button field patched in. `None` when nothing changes (or the stored
/// value cannot be read: the painter's own tolerant parse then decides).
/// A binding whose page is not live is DORMANT and skipped; a value the field
/// cannot hold is skipped too (the literal stays, never a broken string).
pub fn overlay_overrides(
    raw: &str,
    bound: &[(PerButtonPath, ResolvedBinding)],
    pages: &ReportPages,
) -> Option<String> {
    let mut list = parse_stored(raw)?;
    let mut changed = false;
    for (path, value) in bound {
        let Some(patch) = overlay_value(value, &path.field) else { continue };
        let Some(page) = pages.resolve(&path.page_key) else { continue };
        let at = match_entry(&list, page, pages);
        let mut entry = match at {
            Some(i) => list[i].clone(),
            None => new_entry(&path.page_key, page),
        };
        if set_field(&mut entry, &path.field, &patch, false).is_err() {
            continue;
        }
        match at {
            Some(i) => {
                if list[i] != entry {
                    list[i] = entry;
                    changed = true;
                }
            }
            None if entry_is_empty(&entry) => {}
            None => {
                list.push(entry);
                changed = true;
            }
        }
    }
    changed.then(|| serialize_page_overrides(&list))
}

/// The refusal for a page key that names no report page.
pub fn no_page_sentence(page_key: &str) -> String {
    match page_key.strip_prefix(PAGE_NAME_KEY_PREFIX) {
        Some(name) => format!("There is no report page named '{name}' in this workbook, so its navigator button has no setting to change."),
        None => format!("There is no report page with id '{page_key}' in this workbook, so its navigator button has no setting to change."),
    }
}

/// The refusal for a per-button path on a control that is not a navigator.
fn not_a_navigator_sentence(control_type: &str) -> String {
    format!(
        "Per-page button settings belong to a Page Navigator; this control is a {}.",
        if control_type.is_empty() { "control of no type" } else { control_type }
    )
}

/// The extra gate a per-button path passes at `Set` and `SetLiteral`: the
/// control IS a Page Navigator and the page key names a live report page. Any
/// other path passes. (An EXISTING binding whose page goes away stays, dormant:
/// this gate is for new writes only.)
pub fn check_binding_target(state: &AppState, object: &ObjectBindingRef, path: &str) -> Result<(), String> {
    if object.kind != ObjectBindingKind::Control {
        return Ok(());
    }
    let Some(target) = per_button_path(path) else { return Ok(()) };
    let control_type = {
        let controls = state.controls.read().map_err(|e| e.to_string())?;
        controls
            .values()
            .find(|meta| super::object_json::control_uid(meta) == Some(object.id.as_str()))
            .map(|meta| meta.control_type.clone())
    };
    let Some(control_type) = control_type else {
        return Err(format!("There is no control with id '{}' in this workbook.", object.id));
    };
    if control_type != PAGE_NAVIGATOR_CONTROL_TYPE {
        return Err(not_a_navigator_sentence(&control_type));
    }
    if ReportPages::read(state).resolve(&target.page_key).is_none() {
        return Err(no_page_sentence(&target.page_key));
    }
    Ok(())
}
