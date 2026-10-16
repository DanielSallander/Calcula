//! FILENAME: core/identity/src/types.rs
//! PURPOSE: Newtype wrappers over [u8; 16] for the three kinds of stable identity.
//! CONTEXT: All IDs are UUID v7 (128-bit, time-sortable, globally unique).
//! Stored internally as [u8; 16]. Serialized to JSON as 36-char canonical UUID
//! strings (e.g., "01912345-6789-7abc-8def-0123456789ab").

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Internal byte representation of a UUID v7.
type RawId = [u8; 16];

// ---------------------------------------------------------------------------
// Macro to define ID newtypes with common impls
// ---------------------------------------------------------------------------

macro_rules! define_id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(RawId);

        impl $name {
            /// Sentinel value representing "not yet assigned."
            /// All zeroes — never produced by the UUID v7 generator.
            pub const ZERO: Self = Self([0u8; 16]);

            /// Create from raw bytes.
            pub const fn from_bytes(bytes: [u8; 16]) -> Self {
                Self(bytes)
            }

            /// Access the raw bytes.
            pub const fn as_bytes(&self) -> &[u8; 16] {
                &self.0
            }

            /// Returns true if this is the ZERO sentinel (not a real ID).
            pub const fn is_zero(&self) -> bool {
                // Compare each byte manually for const context
                let b = &self.0;
                b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0
                    && b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 0
                    && b[8] == 0 && b[9] == 0 && b[10] == 0 && b[11] == 0
                    && b[12] == 0 && b[13] == 0 && b[14] == 0 && b[15] == 0
            }

            /// Parse from the 36-char canonical UUID string.
            /// Format: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            pub fn parse(s: &str) -> Option<Self> {
                parse_uuid_str(s).map(Self)
            }

            /// Render as the 36-char canonical UUID string.
            pub fn to_string_canonical(&self) -> String {
                format_uuid(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), format_uuid(&self.0))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", format_uuid(&self.0))
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::ZERO
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&format_uuid(&self.0))
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let s = String::deserialize(deserializer)?;
                parse_uuid_str(&s)
                    .map(Self)
                    .ok_or_else(|| serde::de::Error::custom(
                        format!("invalid UUID string: {}", s)
                    ))
            }
        }
    };
}

define_id_type! {
    /// Stable identity for a single cell within a sheet.
    /// Auto-minted when a cell becomes a reference target, gets an override,
    /// or contains a formula. Plain data cells carry no CellId.
    CellId
}

define_id_type! {
    /// Stable identity for a worksheet.
    /// Survives renames, reordering, and cross-workbook references.
    SheetId
}

define_id_type! {
    /// Stable identity for a reference site within a formula AST.
    /// Every reference node (CellRef, Range, ColumnRef, RowRef, Sheet3DRef,
    /// TableRef, NamedRef, SpillRef) carries one of these.
    /// Survives formula edits that preserve the reference structurally.
    RefSiteId
}

define_id_type! {
    /// Generic stable identity for persisted workbook entities.
    /// Used for tables, charts, slicers, ribbon filters, pivot layouts,
    /// table columns, computed properties, and any other persisted entity
    /// that needs globally unique identity across publishers.
    EntityId
}

// ---------------------------------------------------------------------------
// UUID string formatting and parsing
// ---------------------------------------------------------------------------

/// Format 16 bytes as a 36-char canonical UUID string.
/// "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
fn format_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// Parse a 36-char canonical UUID string into 16 bytes.
/// Returns None on invalid format -- never panics, whatever the input.
///
/// BUG-0469: this used to check the length in BYTES and then slice the
/// dash-stripped string by byte index, so a 36-byte string with a multi-byte
/// character straddling an even offset PANICKED ("byte index 2 is not a char
/// boundary") -- and the input is renderer-supplied (an object binding's id,
/// a sheet id from a script's `api.object(kind, id)` or an MCP tool). It also
/// accepted a `+` inside a hex pair, because `u8::from_str_radix` takes a sign.
/// Now: ASCII only, and every non-dash character an ASCII hex digit, BEFORE any
/// slicing.
fn parse_uuid_str(s: &str) -> Option<RawId> {
    if s.len() != 36 || !s.is_ascii() {
        return None;
    }

    let bytes_str: String = s.chars().filter(|c| *c != '-').collect();
    if bytes_str.len() != 32 || !bytes_str.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }

    let mut result = [0u8; 16];
    for i in 0..16 {
        result[i] = u8::from_str_radix(&bytes_str[i * 2..i * 2 + 2], 16).ok()?;
    }

    // Validate dash positions
    let b = s.as_bytes();
    if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return None;
    }

    Some(result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_sentinel() {
        assert!(CellId::ZERO.is_zero());
        assert!(SheetId::ZERO.is_zero());
        assert!(RefSiteId::ZERO.is_zero());
    }

    #[test]
    fn non_zero_detection() {
        let id = CellId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert!(!id.is_zero());
    }

    #[test]
    fn format_and_parse_roundtrip() {
        let bytes: [u8; 16] = [
            0x01, 0x91, 0x23, 0x45, 0x67, 0x89, 0x7a, 0xbc,
            0x8d, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
        ];
        let id = CellId::from_bytes(bytes);
        let s = id.to_string_canonical();
        assert_eq!(s, "01912345-6789-7abc-8def-0123456789ab");

        let parsed = CellId::parse(&s).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn parse_invalid() {
        assert!(CellId::parse("not-a-uuid").is_none());
        assert!(CellId::parse("01912345-6789-7abc-8def-0123456789a").is_none()); // too short
        assert!(CellId::parse("01912345x6789-7abc-8def-0123456789ab").is_none()); // wrong dash
    }

    /// BUG-0469: renderer-supplied ids reach this parser (object bindings,
    /// sheet ids). A 36-BYTE string holding a multi-byte character used to
    /// panic on a char-boundary slice, and a sign inside a hex pair parsed.
    #[test]
    fn parse_refuses_non_ascii_and_signs_without_panicking() {
        // 36 bytes, 35 chars: 'a', e-acute (2 bytes), then the dashed groups.
        let straddling = format!(
            "a\u{e9}{}-{}-{}-{}-{}",
            "0".repeat(5),
            "0".repeat(4),
            "0".repeat(4),
            "0".repeat(4),
            "0".repeat(12)
        );
        assert_eq!(straddling.len(), 36, "the probe must be 36 BYTES to reach the slice");
        assert!(SheetId::parse(&straddling).is_none());
        // A two-byte character in place of every pair of adjacent hex digits of
        // the canonical form: the dashes keep their byte positions, so the
        // stripped string is 32 BYTES and the old code sliced it -- cutting the
        // character whenever it started at an odd offset.
        let canonical = "00000000-0000-0000-0000-000000000000";
        for i in 0..canonical.len() - 1 {
            if &canonical[i..i + 2] != "00" {
                continue;
            }
            let s = format!("{}\u{e9}{}", &canonical[..i], &canonical[i + 2..]);
            assert_eq!(s.len(), 36);
            assert!(CellId::parse(&s).is_none(), "{s:?}");
        }
        // A sign inside a hex pair is not a hex digit.
        assert!(SheetId::parse("+0000000-0000-0000-0000-000000000000").is_none());
        assert!(SheetId::parse("0-000000-0000-0000-0000-000000000000").is_none());
        // Control: the canonical form, either case, still parses.
        assert!(SheetId::parse("00000000-0000-0000-0000-000000000000").is_some());
        assert!(SheetId::parse("0191ABCD-6789-7ABC-8DEF-0123456789AB").is_some());
    }

    #[test]
    fn serde_roundtrip() {
        let bytes: [u8; 16] = [
            0x01, 0x91, 0x23, 0x45, 0x67, 0x89, 0x7a, 0xbc,
            0x8d, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
        ];
        let id = SheetId::from_bytes(bytes);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"01912345-6789-7abc-8def-0123456789ab\"");

        let deserialized: SheetId = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, id);
    }

    #[test]
    fn ordering_is_bytewise() {
        let a = CellId::from_bytes([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let b = CellId::from_bytes([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert!(a < b);
    }

    #[test]
    fn zero_is_default() {
        let id: RefSiteId = Default::default();
        assert!(id.is_zero());
    }
}
