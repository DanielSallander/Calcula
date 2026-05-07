//! FILENAME: core/calcula-format/src/features/mod.rs
//! Optional feature sections in the .cala format.
//! Each feature is stored in its own directory/file within the ZIP.

pub mod tables;
pub mod slicers;
pub mod ribbon_filters;
#[cfg(test)]
mod ribbon_filter_tests;
pub mod scripts;
pub mod notebooks;
pub mod pivot_layouts;
