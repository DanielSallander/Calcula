//! FILENAME: app/src-tauri/src/object_bindings/catalog_tests.rs
// PURPOSE: The bindable-path catalog: its one-row-per-line spelling (what the TS
//          drift test parses), the never-bindable control keys (read from the
//          controls.rs constants), the row flags against the family gates, and
//          `match_path`.

use super::catalog::*;
use crate::api_types::ObjectBindingKind;
use crate::controls;

// ---------------------------------------------------------------------------
// The table's spelling
// ---------------------------------------------------------------------------

fn catalog_source() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/object_bindings/catalog.rs"),
    )
    .expect("read catalog.rs")
}

/// One row as the TS drift parser will read it.
#[derive(Debug, PartialEq)]
struct ParsedRow {
    kind: String,
    pointer: String,
    value_type: String,
    enum_members: Vec<String>,
    origin: String,
    protect: bool,
    lock: bool,
}

/// The lines between `pub const BINDABLE_PATHS ... = &[` and the closing `];`,
/// minus blanks and comments. Each must be ONE row.
fn table_lines(src: &str) -> Vec<String> {
    let opener = "pub const BINDABLE_PATHS: &[BindablePathSpec] = &[";
    let start = src.find(opener).expect("catalog.rs no longer declares BINDABLE_PATHS in the parsed spelling");
    let body = &src[start + opener.len()..];
    let end = body.find("\n];").expect("BINDABLE_PATHS has no closing `];` line");
    body[..end]
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .map(str::to_string)
        .collect()
}

fn parse_row(line: &str) -> Option<ParsedRow> {
    let re = regex::Regex::new(
        r#"^row\(K::(\w+), "([^"]+)", T::(\w+)(?:\(&\[([^\]]*)\]\))?, O::(\w+), (true|false), (true|false)\),$"#,
    )
    .unwrap();
    let c = re.captures(line)?;
    let enum_members = c
        .get(4)
        .map(|m| {
            m.as_str()
                .split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Some(ParsedRow {
        kind: c[1].to_string(),
        pointer: c[2].to_string(),
        value_type: c[3].to_string(),
        enum_members,
        origin: c[5].to_string(),
        protect: &c[6] == "true",
        lock: &c[7] == "true",
    })
}

fn variant_of_type(t: BindableValueType) -> (String, Vec<String>) {
    match t {
        BindableValueType::Text => ("Text".into(), vec![]),
        BindableValueType::Number => ("Number".into(), vec![]),
        BindableValueType::Integer => ("Integer".into(), vec![]),
        BindableValueType::Boolean => ("Boolean".into(), vec![]),
        BindableValueType::Color => ("Color".into(), vec![]),
        BindableValueType::Media => ("Media".into(), vec![]),
        BindableValueType::Scalar => ("Scalar".into(), vec![]),
        BindableValueType::Enum(m) => ("Enum".into(), m.iter().map(|s| s.to_string()).collect()),
    }
}

/// THE NON-VACUITY HALF OF THE TS DRIFT TEST. The mirror's drift test parses
/// this table line by line; that only means anything if every line IS one row
/// and the parse reproduces the compiled table exactly, in order.
#[test]
fn catalog_rows_are_one_per_line_and_parse() {
    let src = catalog_source();
    let lines = table_lines(&src);
    let parsed: Vec<ParsedRow> = lines
        .iter()
        .map(|l| parse_row(l).unwrap_or_else(|| panic!("not ONE row in the parsed spelling: {l}")))
        .collect();
    assert_eq!(
        parsed.len(),
        BINDABLE_PATHS.len(),
        "the parsed table and the compiled table disagree on the row count"
    );
    assert!(parsed.len() > 50, "only {} rows parsed: the parse is broken, not the table", parsed.len());
    for (p, r) in parsed.iter().zip(BINDABLE_PATHS.iter()) {
        let (variant, members) = variant_of_type(r.value_type);
        let expected = ParsedRow {
            kind: format!("{:?}", r.kind),
            pointer: r.pointer.to_string(),
            value_type: variant,
            enum_members: members,
            origin: format!("{:?}", r.origin),
            protect: r.protect_edit_objects,
            lock: r.lock_objects_position,
        };
        assert_eq!(p, &expected, "row {:?} parses differently from what compiles", r.pointer);
    }
}

#[test]
fn the_row_parser_refuses_a_row_split_over_two_lines() {
    assert!(parse_row(r#"row(K::Chart, "/spec/title", T::Text,"#).is_none());
    assert!(parse_row(r#"O::Family, true, false),"#).is_none());
    assert!(parse_row(r#"row(K::Chart, "/spec/title", T::Text, O::Family, true, false),"#).is_some());
}

#[test]
fn no_pointer_is_listed_twice_for_one_kind() {
    let mut seen = std::collections::HashSet::new();
    for r in BINDABLE_PATHS {
        assert!(seen.insert((r.kind, r.pointer)), "duplicate row {:?} {}", r.kind, r.pointer);
    }
}

// ---------------------------------------------------------------------------
// Never-bindable control keys
// ---------------------------------------------------------------------------

/// Every key the controls.rs constants name as code, held code, action wiring
/// or placement is refused -- read from the constants, never re-typed, so a
/// fourth executable slot added there is refused here the same day.
#[test]
fn never_bindable_covers_executable_held_and_action_keys() {
    let mut keys: Vec<&str> = Vec::new();
    keys.extend(controls::EXECUTABLE_CONTROL_PROPERTIES.iter().copied());
    keys.extend(controls::HELD_CONTROL_PROPERTIES.iter().copied());
    keys.extend(controls::BUTTON_ACTION_PROPERTIES.iter().copied());
    keys.push(controls::PIN_TO_GRID_PROPERTY);
    keys.extend(
        controls::POSITION_SIZE_PROPERTIES
            .iter()
            .copied()
            .filter(|k| *k != "width" && *k != "height"),
    );
    keys.extend(["uid", "embedded", "shapeType", "name", "controlType"]);
    assert!(keys.len() >= 14, "the constants yielded only {} keys", keys.len());
    for key in keys {
        assert!(is_never_bindable_control_key(key), "'{key}' must never be bindable");
        let err = match_path(ObjectBindingKind::Control, &format!("/properties/{key}"))
            .expect_err(&format!("/properties/{key} must be refused"));
        assert!(err.contains(key), "the refusal must name the key: {err}");
    }
    for key in ["width", "height", "text", "fill"] {
        assert!(!is_never_bindable_control_key(key), "'{key}' is not a never-bindable key");
    }
}

/// A control row whose key is never-bindable would be dead: step 2 of
/// `match_path` refuses it before the table is consulted.
#[test]
fn no_control_row_names_a_never_bindable_key() {
    for r in rows_of(ObjectBindingKind::Control) {
        let key = r.pointer.trim_start_matches("/properties/").split('/').next().unwrap();
        assert!(!is_never_bindable_control_key(key), "dead row {}", r.pointer);
    }
}

// ---------------------------------------------------------------------------
// Flags against the family gates (invariant 9: a binding is never a laxer door)
// ---------------------------------------------------------------------------

#[test]
fn row_flags_match_the_family_gates() {
    let mut controls_checked = 0;
    for r in BINDABLE_PATHS {
        match r.kind {
            ObjectBindingKind::Control => {
                let key = r
                    .pointer
                    .strip_prefix("/properties/")
                    .unwrap_or_else(|| panic!("a control row lives under /properties/: {}", r.pointer));
                if key.contains('/') {
                    // Per-button navigator rows (S8d) write through `pageOverrides`.
                    continue;
                }
                assert_eq!(
                    r.protect_edit_objects,
                    controls::GEOMETRY_PROPERTIES.contains(&key),
                    "{}: protect_edit_objects must equal GEOMETRY_PROPERTIES membership",
                    r.pointer
                );
                assert_eq!(
                    r.lock_objects_position,
                    controls::POSITION_SIZE_PROPERTIES.contains(&key),
                    "{}: lock_objects_position must equal POSITION_SIZE_PROPERTIES membership",
                    r.pointer
                );
                controls_checked += 1;
            }
            ObjectBindingKind::Chart | ObjectBindingKind::FloatingRange | ObjectBindingKind::CanvasPage => {
                assert!(
                    r.protect_edit_objects,
                    "{:?} {}: every edit of this family is an editObjects edit",
                    r.kind,
                    r.pointer
                );
                assert!(!r.lock_objects_position, "{:?} {}: not a control position key", r.kind, r.pointer);
            }
            ObjectBindingKind::Slicer | ObjectBindingKind::TimelineSlicer => {
                // Their literal doors (`update_slicer_core`, `update_timeline_with`)
                // apply no editObjects gate today; a binding mirrors the door.
                assert!(!r.protect_edit_objects && !r.lock_objects_position, "{}", r.pointer);
            }
            ObjectBindingKind::Pivot => {}
        }
    }
    assert!(controls_checked >= 20, "only {controls_checked} control rows checked");
    // Non-vacuity: the two flag combinations the gates produce both occur.
    assert!(BINDABLE_PATHS.iter().any(|r| r.kind == ObjectBindingKind::Control && r.protect_edit_objects && !r.lock_objects_position));
    assert!(BINDABLE_PATHS.iter().any(|r| r.kind == ObjectBindingKind::Control && r.protect_edit_objects && r.lock_objects_position));
}

// ---------------------------------------------------------------------------
// match_path
// ---------------------------------------------------------------------------

#[test]
fn match_path_accepts_an_array_index_under_series() {
    let row = match_path(ObjectBindingKind::Chart, "/spec/series/3/name").expect("a series name binds");
    assert_eq!(row.pointer, "/spec/series/*/name");
    assert_eq!(row.value_type, BindableValueType::Text);
}

#[test]
fn match_path_refuses_a_non_index_under_series() {
    let err = match_path(ObjectBindingKind::Chart, "/spec/series/x/name").unwrap_err();
    assert!(err.contains("bindable properties are"), "{err}");
    assert!(match_path(ObjectBindingKind::Chart, "/spec/series/12345/name").is_err(), "at most four digits");
}

#[test]
fn match_path_refuses_control_identity_code_held_action_and_position() {
    let cases = [
        ("/properties/name", "identity"),
        ("/properties/onSelect", "code"),
        ("/properties/heldOnSelect", "code compartment"),
        ("/properties/action", "action"),
        ("/properties/x", "position"),
        ("/properties/pinToGrid", "follows its cells"),
    ];
    for (path, word) in cases {
        let err = match_path(ObjectBindingKind::Control, path).expect_err(path);
        assert!(err.contains(word), "{path}: {err}");
    }
}

/// `name` is a control's identity key, but `/spec/series/*/name` is a chart
/// row: the step-2 refusal applies to the control key segment only.
#[test]
fn the_identity_refusal_does_not_leak_into_other_kinds() {
    assert!(match_path(ObjectBindingKind::Chart, "/spec/series/0/name").is_ok());
}

#[test]
fn match_path_refuses_an_undeclared_control_key() {
    let err = match_path(ObjectBindingKind::Control, "/properties/foo").unwrap_err();
    assert!(err.contains("/properties/text"), "the refusal lists the bindable properties: {err}");
}

// ---------------------------------------------------------------------------
// Page Navigator per-button rows (D §3.18a, S8d)
// ---------------------------------------------------------------------------

const PAGE_ID: &str = "7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f";

/// The whole `pageOverrides` list is never bound (a formula would write raw
/// settings JSON), and the refusal says what to bind instead.
/// SABOTAGE: drop the `segments.len() == 2` arm of `page_overrides_refusal` --
/// the path is then refused by the generic sentence, without "never bound".
#[test]
fn page_overrides_itself_is_refused_by_name() {
    let err = match_path(ObjectBindingKind::Control, "/properties/pageOverrides").unwrap_err();
    assert!(err.contains("never bound"), "{err}");
    assert!(err.contains("/properties/pageOverrides/<page>/text"), "the sentence names the per-button paths: {err}");
}

/// A per-button path is keyed by PAGE (a SheetId or `name:<sheet>`), never by
/// array index; each field has its own typed row.
#[test]
fn per_button_paths_are_keyed_by_page() {
    let cases = [
        ("text", BindableValueType::Text),
        ("fill", BindableValueType::Color),
        ("color", BindableValueType::Color),
        ("borderColor", BindableValueType::Color),
        ("hidden", BindableValueType::Boolean),
    ];
    for (field, ty) in cases {
        for key in [PAGE_ID, "name:Sales"] {
            let path = format!("/properties/pageOverrides/{key}/{field}");
            let row = match_path(ObjectBindingKind::Control, &path).unwrap_or_else(|e| panic!("{path}: {e}"));
            assert_eq!(row.pointer, format!("/properties/pageOverrides/*/{field}"));
            assert_eq!(row.value_type, ty, "{path}");
            assert!(!row.protect_edit_objects && !row.lock_objects_position, "{path}");
        }
    }
    // An index would re-aim at another page's entry when one is added: refused.
    assert!(match_path(ObjectBindingKind::Control, "/properties/pageOverrides/0/text").is_err());
    assert!(match_path(ObjectBindingKind::Control, "/properties/pageOverrides/Sales/text").is_err());
    assert!(match_path(ObjectBindingKind::Control, "/properties/pageOverrides/name:/text").is_err(), "an empty name");
    let long = format!("/properties/pageOverrides/name:{}/text", "x".repeat(32));
    assert!(match_path(ObjectBindingKind::Control, &long).is_err(), "a sheet name is at most 31 characters");
    // A '/' in a sheet name travels escaped (RFC 6901).
    assert!(match_path(ObjectBindingKind::Control, "/properties/pageOverrides/name:Q1~1Q2/text").is_ok());
    assert!(match_path(ObjectBindingKind::Control, "/properties/pageOverrides/name:Sales/caption").is_err());
    assert!(match_path(ObjectBindingKind::Chart, &format!("/properties/pageOverrides/{PAGE_ID}/text")).is_err(), "control rows only");
}

/// `sheetId` / `sheetName` NAME the page an entry is about: refused by name.
/// SABOTAGE: remove "sheetId" from `PAGE_OVERRIDE_IDENTITY_FIELDS` -- the path
/// is then refused by the generic sentence, without "never bound".
#[test]
fn per_button_identity_fields_are_refused_by_name() {
    for field in ["sheetId", "sheetName"] {
        let path = format!("/properties/pageOverrides/{PAGE_ID}/{field}");
        let err = match_path(ObjectBindingKind::Control, &path).unwrap_err();
        assert!(err.contains(field) && err.contains("never bound"), "{path}: {err}");
    }
}

#[test]
fn match_path_refuses_malformed_pointers() {
    let deep = "/a".repeat(MAX_BINDING_PATH_SEGMENTS + 1);
    let long = format!("/{}", "a".repeat(MAX_BINDING_PATH_SEGMENT_CHARS + 1));
    let very_long = "/abcdefgh".repeat(30);
    for bad in ["", "spec/title", "/spec//title", "/spec/ti~2tle", "/spec/title~", &deep, &long, &very_long] {
        assert!(match_path(ObjectBindingKind::Chart, bad).is_err(), "{bad:?} must be refused");
    }
    assert_eq!(pointer_segments("/a/b").unwrap(), vec!["a", "b"]);
    assert_eq!(pointer_segments(&"/a".repeat(MAX_BINDING_PATH_SEGMENTS)).unwrap().len(), MAX_BINDING_PATH_SEGMENTS);
}

#[test]
fn rfc6901_escapes_round_trip() {
    assert_eq!(unescape_segment("a~1b~0c").as_deref(), Some("a/b~c"));
    assert_eq!(escape_segment("a/b~c"), "a~1b~0c");
    assert_eq!(unescape_segment("bad~"), None);
}

#[test]
fn a_series_color_key_is_a_name_not_an_index() {
    assert!(match_path(ObjectBindingKind::Chart, "/spec/seriesColors/Revenue 2024").is_ok());
    assert!(match_path(ObjectBindingKind::Chart, "/spec/seriesColors/a~1b").is_err(), "a '/' is not a series key");
}

/// A PivotTable box's GEOMETRY is not bindable: the pivot kind's only rows
/// are its visual container's (WP-C), so its frame position is refused by the
/// generic sentence, which lists what IS bindable.
#[test]
fn pivot_geometry_is_not_bindable() {
    let err = match_path(ObjectBindingKind::Pivot, "/canvasFrame/x").unwrap_err();
    assert!(err.contains("bindable properties are"), "{err}");
    assert!(err.contains("/canvasFrame/container/border/radius"), "{err}");
    assert!(match_path(ObjectBindingKind::Pivot, "/canvasFrame/container/border/radius").is_ok());
}

/// Every row is reachable: a concrete path built from its pattern matches it.
#[test]
fn every_row_is_reachable_through_match_path() {
    for r in BINDABLE_PATHS {
        let segs: Vec<&str> = r.pointer.trim_start_matches('/').split('/').collect();
        let concrete: Vec<String> = segs
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if *s == "*" {
                    match segs[i - 1] {
                        "seriesColors" => "Revenue".to_string(),
                        "pageOverrides" => "name:Sales".to_string(),
                        _ => "0".to_string(),
                    }
                } else {
                    s.to_string()
                }
            })
            .collect();
        let path = format!("/{}", concrete.join("/"));
        let found = match_path(r.kind, &path).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(found.pointer, r.pointer, "{path} matched the wrong row");
    }
}

#[test]
fn container_roots_are_the_contract() {
    assert_eq!(container_root(ObjectBindingKind::Chart), Some("/spec/container"));
    assert_eq!(container_root(ObjectBindingKind::Pivot), Some("/canvasFrame/container"));
    assert_eq!(container_root(ObjectBindingKind::Slicer), Some("/container"));
    assert_eq!(container_root(ObjectBindingKind::TimelineSlicer), Some("/container"));
    assert_eq!(container_root(ObjectBindingKind::FloatingRange), Some("/container"));
    assert_eq!(container_root(ObjectBindingKind::Control), None);
    assert_eq!(container_root(ObjectBindingKind::CanvasPage), None);
}

#[test]
fn kind_wire_names_match_serde() {
    for k in ObjectBindingKind::ALL {
        assert_eq!(serde_json::to_value(k).unwrap(), serde_json::Value::String(k.wire_name().into()));
        assert_eq!(ObjectBindingKind::from_wire(k.wire_name()), Some(k));
    }
    assert_eq!(ObjectBindingKind::from_wire("Chart"), None, "wire names are case-sensitive");
    assert_eq!(ObjectBindingKind::from_wire("tablix"), None);
}

// ---------------------------------------------------------------------------
// The visual container rows (WP-C S7b)
// ---------------------------------------------------------------------------

/// The catalog type a container field type maps to.
fn catalog_type_of(t: visual_format::FieldType) -> BindableValueType {
    match t {
        visual_format::FieldType::Number => BindableValueType::Number,
        visual_format::FieldType::Integer => BindableValueType::Integer,
        visual_format::FieldType::Boolean => BindableValueType::Boolean,
        visual_format::FieldType::Color => BindableValueType::Color,
        visual_format::FieldType::Text => BindableValueType::Text,
        visual_format::FieldType::Enum(m) => BindableValueType::Enum(m),
    }
}

/// The container fields a kind deliberately has NO Container row for (WP-C
/// spec 2.7): `lockAspect` is never bound; the rest live elsewhere (a Family
/// row) or are the object's identity / move handle.
fn container_exclusions(kind: ObjectBindingKind) -> &'static [&'static str] {
    match kind {
        ObjectBindingKind::Chart => &["/lockAspect", "/title/text", "/title/color", "/title/fontSize"],
        ObjectBindingKind::Slicer | ObjectBindingKind::TimelineSlicer => {
            &["/lockAspect", "/title/text", "/title/show"]
        }
        ObjectBindingKind::Pivot => &["/lockAspect"],
        ObjectBindingKind::FloatingRange => &[
            "/lockAspect",
            "/title/text",
            "/title/show",
            "/padding/top",
            "/padding/right",
            "/padding/bottom",
            "/padding/left",
        ],
        ObjectBindingKind::Control | ObjectBindingKind::CanvasPage => &[],
    }
}

/// BOTH DIRECTIONS against `visual_format::FIELD_POINTERS`: every Container
/// row sits under its kind's root, names a real field and carries that field's
/// type; and every field of every container kind has exactly one row unless
/// the spec's table excludes it (and then it has none). Flags mirror the door.
///
/// SABOTAGE (confirmed): delete the pivot `/canvasFrame/container/border/radius`
/// row -> "Pivot /border/radius has no Container row".
#[test]
fn container_rows_are_the_field_table() {
    let container_kinds = [
        ObjectBindingKind::Chart,
        ObjectBindingKind::Pivot,
        ObjectBindingKind::Slicer,
        ObjectBindingKind::TimelineSlicer,
        ObjectBindingKind::FloatingRange,
    ];
    let mut container_rows = 0;
    for r in BINDABLE_PATHS.iter().filter(|r| r.origin == BindableOrigin::Container) {
        container_rows += 1;
        let root = container_root(r.kind).unwrap_or_else(|| panic!("{:?} has no container root: {}", r.kind, r.pointer));
        let suffix = r
            .pointer
            .strip_prefix(root)
            .unwrap_or_else(|| panic!("{} is not under {root}", r.pointer));
        let ty = visual_format::field_type(suffix)
            .unwrap_or_else(|| panic!("{} names no visual_format field", r.pointer));
        assert_eq!(r.value_type, catalog_type_of(ty), "{:?} {}: the field's type", r.kind, r.pointer);
        assert!(
            !container_exclusions(r.kind).contains(&suffix),
            "{:?} {} is excluded by the spec but has a row",
            r.kind,
            r.pointer
        );
        let protect = matches!(r.kind, ObjectBindingKind::Chart | ObjectBindingKind::FloatingRange);
        assert_eq!(r.protect_edit_objects, protect, "{:?} {}: protect mirrors the door", r.kind, r.pointer);
        assert!(!r.lock_objects_position, "{:?} {}: a container field is formatting", r.kind, r.pointer);
    }
    for kind in container_kinds {
        let root = container_root(kind).unwrap();
        for (suffix, _) in visual_format::FIELD_POINTERS {
            let pointer = format!("{root}{suffix}");
            let rows: Vec<_> = rows_of(kind).filter(|r| r.pointer == pointer).collect();
            if container_exclusions(kind).contains(suffix) {
                assert!(rows.is_empty(), "{kind:?} {suffix} is excluded but has a row");
                assert!(match_path(kind, &pointer).is_err(), "{kind:?} {pointer} must be refused");
            } else {
                assert_eq!(rows.len(), 1, "{kind:?} {suffix} has no Container row");
                assert_eq!(rows[0].origin, BindableOrigin::Container, "{pointer}");
            }
        }
    }
    // 51 fields x 5 kinds minus the exclusions (4 + 1 + 3 + 3 + 7).
    assert_eq!(container_rows, 51 * 5 - 18, "the Container row count");
    // Never two spellings of one fact: no Family row lives under a container root.
    for r in BINDABLE_PATHS.iter().filter(|r| r.origin == BindableOrigin::Family) {
        if let Some(root) = container_root(r.kind) {
            assert!(!r.pointer.starts_with(&format!("{root}/")), "Family row {} under the container root", r.pointer);
        }
    }
}

/// A control's container keys are EXACT Family rows of their field's type
/// (there is no `/properties/*` wildcard, so without them every key would be
/// refused) -- every `CONTROL_CONTAINER_PROPERTY_KEYS` key but
/// `containerLockAspect`, which is never bound.
///
/// SABOTAGE (confirmed): change the `containerTitleFontSize` row's type to
/// `T::Text` -> "the Number row, not text".
#[test]
fn control_container_keys_are_typed_family_rows() {
    let row = match_path(ObjectBindingKind::Control, "/properties/containerTitleFontSize").expect("a container key binds");
    assert_eq!(row.pointer, "/properties/containerTitleFontSize");
    assert_eq!(row.value_type, BindableValueType::Number, "the Number row, not text");
    let mut checked = 0;
    for key in visual_format::CONTROL_CONTAINER_PROPERTY_KEYS {
        let path = format!("/properties/{key}");
        if *key == "containerLockAspect" {
            let err = match_path(ObjectBindingKind::Control, &path).unwrap_err();
            assert!(err.contains("bindable properties are"), "{err}");
            continue;
        }
        let row = match_path(ObjectBindingKind::Control, &path).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(row.pointer, path, "an exact row");
        assert_eq!(row.origin, BindableOrigin::Family, "{path}");
        let field = visual_format::control_container_key_pointer(key).unwrap();
        let ty = visual_format::field_type(field).unwrap();
        assert_eq!(row.value_type, catalog_type_of(ty), "{key}: the field's type");
        assert!(!row.protect_edit_objects && !row.lock_objects_position, "{key}: formatting");
        checked += 1;
    }
    assert_eq!(checked, 50);
}

/// R5's one spelling: a chart's title TEXT, colour and size are Family rows
/// (`/spec/title`, the theme); the container spelling of each is refused,
/// while the title's VISIBILITY and style are container rows.
#[test]
fn chart_title_text_has_one_spelling() {
    for leaf in ["text", "color", "fontSize"] {
        let path = format!("/spec/container/title/{leaf}");
        assert!(match_path(ObjectBindingKind::Chart, &path).is_err(), "{path} must be refused");
    }
    assert_eq!(match_path(ObjectBindingKind::Chart, "/spec/title").unwrap().origin, BindableOrigin::Family);
    let show = match_path(ObjectBindingKind::Chart, "/spec/container/title/show").unwrap();
    assert_eq!((show.origin, show.value_type), (BindableOrigin::Container, BindableValueType::Boolean));
    let align = match_path(ObjectBindingKind::Chart, "/spec/container/title/align").unwrap();
    assert_eq!(align.value_type, BindableValueType::Enum(&["left", "center", "right"]));
    // A slicer's title text and visibility are its Family rows, never the container's.
    assert!(match_path(ObjectBindingKind::Slicer, "/container/title/text").is_err());
    assert!(match_path(ObjectBindingKind::Slicer, "/container/title/show").is_err());
    assert!(match_path(ObjectBindingKind::Slicer, "/container/title/color").is_ok());
    // A floating range's padding and title are never bound.
    assert!(match_path(ObjectBindingKind::FloatingRange, "/container/padding/top").is_err());
    assert!(match_path(ObjectBindingKind::FloatingRange, "/container/title/text").is_err());
    assert!(match_path(ObjectBindingKind::FloatingRange, "/container/border/radius").is_ok());
}
