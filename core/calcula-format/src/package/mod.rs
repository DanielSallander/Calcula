//! FILENAME: core/calcula-format/src/package/mod.rs
//! Calcula Package Format (.calp) — distributable report objects.
//!
//! A `.calp` file is a ZIP archive that is a strict subset of the `.cala` format,
//! plus a `package.json` descriptor. This allows reuse of existing serialization
//! logic while adding metadata for distribution, data binding, and provenance.
//!
//! Internal ZIP structure:
//! ```text
//! package.json                      # Package metadata + data source declarations
//! manifest.json                     # Standard .cala manifest (only included sheets)
//! styles/registry.json              # Styles used by included objects
//! sheets/0_Dashboard/data.json      # Sheet data (if sheet bundle)
//! sheets/0_Dashboard/styles.json
//! sheets/0_Dashboard/layout.json
//! tables/table_1.json               # Individual table definitions
//! files/README.md                   # Documentation files
//! ```

pub mod manifest;
pub mod parser;
pub mod exporter;
pub mod merger;
