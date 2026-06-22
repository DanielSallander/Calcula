//! FILENAME: core/calcula-format/src/atomic.rs
//! Atomic file write: build the full bytes, write to a sibling temp file in the
//! same directory, fsync, then atomically rename over the target. The original
//! file is never truncated until the new bytes are fully flushed — so a crash or
//! mid-write error can never corrupt an existing workbook (critical once the
//! payload is encrypted and therefore unrecoverable if truncated).

use crate::error::FormatError;
use std::path::Path;

pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), FormatError> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut tmp, data)?;
    tmp.as_file().sync_all()?;
    // Atomic same-volume replace (ReplaceFile/MoveFileEx semantics on Windows).
    tmp.persist(path).map_err(|e| FormatError::Io(e.error))?;
    Ok(())
}
