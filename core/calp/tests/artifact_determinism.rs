//! FILENAME: core/calp/tests/artifact_determinism.rs
//! PURPOSE: Identical content must produce identical artifact BYTES.
//! CONTEXT: A `.calp` artifact's SHA-256 is load-bearing three times over — it
//! is what the signed checksum map attests, what the content-addressed blob
//! store dedups on, and what a version-to-version diff uses to decide whether
//! anything changed at all. All three quietly stop working if serializing the
//! same data twice can produce different bytes.
//!
//! It could. `PublishedSheetMetadata` serialized four `HashSet<u32>` fields, and
//! HashSet iteration order is per-instance, so a workbook with hidden rows
//! published twice wrote two different `metadata.json` files with the same
//! meaning: the blob store kept both, and a diff would have reported a sheet as
//! "changed" because nobody had changed it. The fix is that the SERIALIZED form
//! is ordered (`BTreeSet`) while the in-memory `Sheet` keeps its hash sets; this
//! test is what keeps the next such field from slipping in.

use std::collections::BTreeMap;
use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::registry::LocalRegistry;
use calp::transport::RegistryTransport;
use calp::version::SemVer;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

/// Sheet ids to build both workbooks with.
///
/// Identity has to be held constant for this comparison to be about
/// SERIALIZATION: a freshly-built `Sheet` mints a new `SheetId`, and two
/// workbooks with different ids write to different artifact PATHS, which is
/// correct behaviour rather than a determinism failure.
fn fixed_sheet_ids() -> Vec<identity::SheetId> {
    (0..3)
        .map(|_| identity::SheetId::from_bytes(identity::generate_uuid_v7()))
        .collect()
}

/// A workbook exercising the collections whose order is not guaranteed:
/// hidden rows/cols (both effective and user-hidden), on several sheets.
///
/// Every call builds the hash sets FRESH. That matters: Rust seeds each
/// `HashSet`'s hasher per instance, so two separately-constructed sets holding
/// the same numbers can iterate in different orders — while a CLONE keeps the
/// original's seed and would iterate identically, making a clone-based test
/// vacuous for exactly the thing being tested.
fn workbook_with_unordered_collections(ids: &[identity::SheetId]) -> Workbook {
    let mut wb = Workbook::default();
    // ASSIGN, never push: a default Workbook already carries a blank sheet with
    // a freshly minted id, and appending after it would publish that sheet —
    // whose identity differs per call — instead of the three built here.
    wb.sheets = Vec::new();
    for (s, name) in ["Dashboard", "Data", "Notes"].iter().enumerate() {
        let mut sheet = Sheet::new((*name).to_string());
        sheet.id = ids[s];
        for r in 0..12u32 {
            sheet.cells.insert(
                (r, 0),
                SavedCell::from_cell(&Cell::new_text(format!("s{s} r{r}"))),
            );
            sheet
                .cells
                .insert((r, 1), SavedCell::from_cell(&Cell::new_number((r * 7) as f64)));
        }
        // Deliberately inserted out of order and interleaved.
        sheet.hidden_rows = [9u32, 2, 7, 4, 11, 1].into_iter().collect();
        sheet.hidden_cols = [5u32, 1, 3].into_iter().collect();
        sheet.user_hidden_rows = [7u32, 2].into_iter().collect();
        sheet.user_hidden_cols = [3u32].into_iter().collect();
        wb.sheets.push(sheet);
    }
    wb
}

fn publish_at(
    reg: &LocalRegistry,
    prof: &Path,
    wb: &Workbook,
    package: &str,
    version: SemVer,
    mode: PushMode,
) {
    let request = PublishRequest {
        workbook: wb,
        package_name: package.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "determinism probe".to_string(),
        sheet_indices: vec![0, 1, 2],
        now: "2026-08-29T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(reg, &request, prof).expect("publish failed");
}

/// Every artifact of a version, as `rel_path -> bytes`.
fn artifacts_of(reg: &LocalRegistry, package: &str, version: &str) -> BTreeMap<String, Vec<u8>> {
    let manifest = reg.get_version_manifest(package, version).unwrap();
    manifest
        .artifact_checksums
        .keys()
        .map(|rel| {
            let bytes = reg
                .read_artifact(package, version, rel)
                .unwrap()
                .unwrap_or_else(|| panic!("artifact {rel} listed but missing"));
            (rel.clone(), bytes)
        })
        .collect()
}

#[test]
fn publishing_identical_content_twice_produces_identical_bytes() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(dir.path()).unwrap();

    // Two separately-BUILT workbooks with identical content and identical sheet
    // identity. Building them separately is the point (see the builder's note on
    // per-instance hasher seeds); fixing the ids is what makes the comparison
    // about serialization rather than about identity.
    let ids = fixed_sheet_ids();
    let a = workbook_with_unordered_collections(&ids);
    let b = workbook_with_unordered_collections(&ids);

    publish_at(&reg, prof.path(), &a, "det", SemVer::new(1, 0, 0), PushMode::CreateNew);
    publish_at(
        &reg,
        prof.path(),
        &b,
        "det",
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let v1 = artifacts_of(&reg, "det", "1.0.0");
    let v2 = artifacts_of(&reg, "det", "1.0.1");

    assert_eq!(
        v1.keys().collect::<Vec<_>>(),
        v2.keys().collect::<Vec<_>>(),
        "the same workbook must produce the same artifact SET"
    );
    for (rel, bytes_a) in &v1 {
        let bytes_b = &v2[rel];
        assert_eq!(
            bytes_a, bytes_b,
            "artifact `{rel}` differs between two publishes of identical content — \
             something in its serialized form is order-dependent, which silently \
             breaks blob dedup and makes a version diff report a change nobody made"
        );
    }
}

#[test]
fn identical_content_dedups_to_one_blob_per_artifact() {
    // The consequence of the property above, measured where it pays off: two
    // versions of unchanged content should not double the registry's size.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(dir.path()).unwrap();

    let ids = fixed_sheet_ids();
    let a = workbook_with_unordered_collections(&ids);
    let b = workbook_with_unordered_collections(&ids);
    publish_at(&reg, prof.path(), &a, "det", SemVer::new(1, 0, 0), PushMode::CreateNew);
    publish_at(
        &reg,
        prof.path(),
        &b,
        "det",
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let v1 = reg.get_version_manifest("det", "1.0.0").unwrap();
    let v2 = reg.get_version_manifest("det", "1.0.1").unwrap();
    assert_eq!(
        v1.artifact_checksums, v2.artifact_checksums,
        "identical content must hash identically, artifact for artifact"
    );

    let blobs = count_blobs(dir.path());
    let unique: std::collections::HashSet<&String> =
        v1.artifact_checksums.values().chain(v2.artifact_checksums.values()).collect();
    assert_eq!(
        blobs,
        unique.len(),
        "one blob per unique content hash — a republish of unchanged content \
         should add no bytes to the registry"
    );
}

#[test]
fn a_real_change_still_changes_the_bytes() {
    // The positive control. A determinism test that passes because everything
    // serializes to the same thing regardless of content would be worse than no
    // test at all.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(dir.path()).unwrap();

    let ids = fixed_sheet_ids();
    let a = workbook_with_unordered_collections(&ids);
    let mut b = workbook_with_unordered_collections(&ids);
    b.sheets[0]
        .cells
        .insert((0, 2), SavedCell::from_cell(&Cell::new_text("new".to_string())));

    publish_at(&reg, prof.path(), &a, "det", SemVer::new(1, 0, 0), PushMode::CreateNew);
    publish_at(
        &reg,
        prof.path(),
        &b,
        "det",
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let v1 = reg.get_version_manifest("det", "1.0.0").unwrap();
    let v2 = reg.get_version_manifest("det", "1.0.1").unwrap();
    let sheet_id = v1.sheets[0].sheet_id.to_string();
    let key = format!("sheets/{sheet_id}/data.json");
    assert_ne!(
        v1.artifact_checksums.get(&key),
        v2.artifact_checksums.get(&key),
        "an edited sheet's data artifact must hash differently"
    );
    // …and the sheets nobody touched must NOT, which is what makes an
    // artifact-level diff a diff rather than a list of every file.
    let untouched = format!("sheets/{}/data.json", v1.sheets[1].sheet_id);
    assert_eq!(
        v1.artifact_checksums.get(&untouched),
        v2.artifact_checksums.get(&untouched),
        "an untouched sheet must hash the same across versions"
    );
}

fn count_blobs(root: &Path) -> usize {
    let blobs = root.join(".blobs");
    let mut n = 0;
    if let Ok(shards) = std::fs::read_dir(&blobs) {
        for shard in shards.flatten() {
            if let Ok(files) = std::fs::read_dir(shard.path()) {
                n += files
                    .flatten()
                    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .count();
            }
        }
    }
    n
}
