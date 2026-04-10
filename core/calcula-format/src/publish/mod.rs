//! FILENAME: core/calcula-format/src/publish/mod.rs
//! Linked Sheet Publishing — centralized report distribution.
//!
//! Authors publish sheets from BI-connected workbooks to a flat directory
//! (sibling to the BI model file). Consumers link those sheets into their
//! own workbooks, with auto/manual refresh from the published source.
//!
//! Publication directory structure:
//! ```text
//! {model_name}.calp-pub/
//!   publish-manifest.json
//!   sheets/
//!     0_Dashboard/
//!       data.json
//!       styles.json
//!       layout.json
//! ```

pub mod manifest;
pub mod linked;
pub mod writer;
pub mod reader;
