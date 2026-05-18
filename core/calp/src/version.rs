//! FILENAME: core/calp/src/version.rs
//! PURPOSE: SemVer parsing and version pin resolution.
//! CONTEXT: Implements the version pinning grammar from the design doc:
//! =1.2.3, >=1.0 <2.0, ~1.2, ^1.2, latest

use std::fmt;
use serde::{Deserialize, Serialize};
use crate::error::CalpError;

/// A semantic version (major.minor.patch).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SemVer {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl SemVer {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Parse from string like "1.2.3" or "1.2" (patch defaults to 0) or "1" (minor+patch default).
    pub fn parse(s: &str) -> Result<Self, CalpError> {
        let parts: Vec<&str> = s.trim().split('.').collect();
        match parts.len() {
            1 => {
                let major = parts[0].parse::<u32>()
                    .map_err(|_| CalpError::InvalidVersion(s.to_string()))?;
                Ok(Self::new(major, 0, 0))
            }
            2 => {
                let major = parts[0].parse::<u32>()
                    .map_err(|_| CalpError::InvalidVersion(s.to_string()))?;
                let minor = parts[1].parse::<u32>()
                    .map_err(|_| CalpError::InvalidVersion(s.to_string()))?;
                Ok(Self::new(major, minor, 0))
            }
            3 => {
                let major = parts[0].parse::<u32>()
                    .map_err(|_| CalpError::InvalidVersion(s.to_string()))?;
                let minor = parts[1].parse::<u32>()
                    .map_err(|_| CalpError::InvalidVersion(s.to_string()))?;
                let patch = parts[2].parse::<u32>()
                    .map_err(|_| CalpError::InvalidVersion(s.to_string()))?;
                Ok(Self::new(major, minor, patch))
            }
            _ => Err(CalpError::InvalidVersion(s.to_string())),
        }
    }
}

impl fmt::Display for SemVer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// A version constraint expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum VersionPin {
    /// `=1.2.3` — exact match
    Exact(SemVer),
    /// `~1.2` — latest patch: >=1.2.0 <1.3.0
    Tilde(SemVer),
    /// `^1.2` — latest minor: >=1.2.0 <2.0.0
    Caret(SemVer),
    /// `>=1.0.0 <2.0.0` — explicit range
    Range { lower: SemVer, upper: SemVer },
    /// `latest` — always newest
    Latest,
}

impl VersionPin {
    /// Parse a version pin string.
    pub fn parse(s: &str) -> Result<Self, CalpError> {
        let s = s.trim();

        if s.eq_ignore_ascii_case("latest") {
            return Ok(VersionPin::Latest);
        }

        // Tilde: ~1.2 or ~1.2.3
        if let Some(rest) = s.strip_prefix('~') {
            let ver = SemVer::parse(rest.trim())?;
            return Ok(VersionPin::Tilde(ver));
        }

        // Caret: ^1.2 or ^1.2.3
        if let Some(rest) = s.strip_prefix('^') {
            let ver = SemVer::parse(rest.trim())?;
            return Ok(VersionPin::Caret(ver));
        }

        // Range: >=1.0 <2.0 or >=1.0.0 <2.0.0
        if s.starts_with(">=") {
            let parts: Vec<&str> = s.splitn(2, '<').collect();
            if parts.len() == 2 {
                let lower_str = parts[0].trim().strip_prefix(">=").unwrap().trim();
                let upper_str = parts[1].trim();
                let lower = SemVer::parse(lower_str)?;
                let upper = SemVer::parse(upper_str)?;
                return Ok(VersionPin::Range { lower, upper });
            }
        }

        // Exact: =1.2.3 or just 1.2.3
        let ver_str = s.strip_prefix('=').unwrap_or(s).trim();
        let ver = SemVer::parse(ver_str)?;
        Ok(VersionPin::Exact(ver))
    }

    /// Check if a version satisfies this pin.
    pub fn matches(&self, version: &SemVer) -> bool {
        match self {
            VersionPin::Exact(v) => version == v,
            VersionPin::Tilde(v) => {
                // >=v.major.v.minor.v.patch <v.major.(v.minor+1).0
                version.major == v.major
                    && version.minor == v.minor
                    && version.patch >= v.patch
            }
            VersionPin::Caret(v) => {
                // >=v <(v.major+1).0.0
                version.major == v.major
                    && (version.minor > v.minor
                        || (version.minor == v.minor && version.patch >= v.patch))
            }
            VersionPin::Range { lower, upper } => {
                version >= lower && version < upper
            }
            VersionPin::Latest => true,
        }
    }

    /// Resolve the best matching version from a list of available versions.
    /// Returns the highest version that satisfies the constraint.
    pub fn resolve<'a>(&self, available: &'a [SemVer]) -> Option<&'a SemVer> {
        available.iter()
            .filter(|v| self.matches(v))
            .max()
    }
}

impl fmt::Display for VersionPin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VersionPin::Exact(v) => write!(f, "={}", v),
            VersionPin::Tilde(v) => write!(f, "~{}", v),
            VersionPin::Caret(v) => write!(f, "^{}", v),
            VersionPin::Range { lower, upper } => write!(f, ">={} <{}", lower, upper),
            VersionPin::Latest => write!(f, "latest"),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver() {
        assert_eq!(SemVer::parse("1.2.3").unwrap(), SemVer::new(1, 2, 3));
        assert_eq!(SemVer::parse("1.2").unwrap(), SemVer::new(1, 2, 0));
        assert_eq!(SemVer::parse("1").unwrap(), SemVer::new(1, 0, 0));
    }

    #[test]
    fn semver_ordering() {
        assert!(SemVer::new(1, 0, 0) < SemVer::new(2, 0, 0));
        assert!(SemVer::new(1, 1, 0) < SemVer::new(1, 2, 0));
        assert!(SemVer::new(1, 1, 1) < SemVer::new(1, 1, 2));
    }

    #[test]
    fn parse_exact_pin() {
        let pin = VersionPin::parse("=1.2.3").unwrap();
        assert_eq!(pin, VersionPin::Exact(SemVer::new(1, 2, 3)));
    }

    #[test]
    fn parse_bare_version_is_exact() {
        let pin = VersionPin::parse("1.2.3").unwrap();
        assert_eq!(pin, VersionPin::Exact(SemVer::new(1, 2, 3)));
    }

    #[test]
    fn parse_tilde() {
        let pin = VersionPin::parse("~1.2").unwrap();
        assert_eq!(pin, VersionPin::Tilde(SemVer::new(1, 2, 0)));
    }

    #[test]
    fn parse_caret() {
        let pin = VersionPin::parse("^1.2").unwrap();
        assert_eq!(pin, VersionPin::Caret(SemVer::new(1, 2, 0)));
    }

    #[test]
    fn parse_range() {
        let pin = VersionPin::parse(">=1.0 <2.0").unwrap();
        assert_eq!(pin, VersionPin::Range {
            lower: SemVer::new(1, 0, 0),
            upper: SemVer::new(2, 0, 0),
        });
    }

    #[test]
    fn parse_latest() {
        let pin = VersionPin::parse("latest").unwrap();
        assert_eq!(pin, VersionPin::Latest);
    }

    #[test]
    fn exact_match() {
        let pin = VersionPin::Exact(SemVer::new(1, 2, 3));
        assert!(pin.matches(&SemVer::new(1, 2, 3)));
        assert!(!pin.matches(&SemVer::new(1, 2, 4)));
        assert!(!pin.matches(&SemVer::new(1, 3, 0)));
    }

    #[test]
    fn tilde_match() {
        let pin = VersionPin::Tilde(SemVer::new(1, 2, 0));
        assert!(pin.matches(&SemVer::new(1, 2, 0)));
        assert!(pin.matches(&SemVer::new(1, 2, 9)));
        assert!(!pin.matches(&SemVer::new(1, 3, 0)));
        assert!(!pin.matches(&SemVer::new(2, 0, 0)));
    }

    #[test]
    fn caret_match() {
        let pin = VersionPin::Caret(SemVer::new(1, 2, 0));
        assert!(pin.matches(&SemVer::new(1, 2, 0)));
        assert!(pin.matches(&SemVer::new(1, 2, 9)));
        assert!(pin.matches(&SemVer::new(1, 5, 0)));
        assert!(!pin.matches(&SemVer::new(2, 0, 0)));
        assert!(!pin.matches(&SemVer::new(1, 1, 0)));
    }

    #[test]
    fn range_match() {
        let pin = VersionPin::Range {
            lower: SemVer::new(1, 0, 0),
            upper: SemVer::new(2, 0, 0),
        };
        assert!(pin.matches(&SemVer::new(1, 0, 0)));
        assert!(pin.matches(&SemVer::new(1, 9, 9)));
        assert!(!pin.matches(&SemVer::new(2, 0, 0))); // upper bound exclusive
        assert!(!pin.matches(&SemVer::new(0, 9, 0)));
    }

    #[test]
    fn latest_matches_everything() {
        let pin = VersionPin::Latest;
        assert!(pin.matches(&SemVer::new(0, 0, 1)));
        assert!(pin.matches(&SemVer::new(99, 99, 99)));
    }

    #[test]
    fn resolve_picks_highest_match() {
        let versions = vec![
            SemVer::new(1, 0, 0),
            SemVer::new(1, 1, 0),
            SemVer::new(1, 2, 0),
            SemVer::new(2, 0, 0),
        ];

        let pin = VersionPin::Caret(SemVer::new(1, 0, 0));
        assert_eq!(pin.resolve(&versions), Some(&SemVer::new(1, 2, 0)));

        let pin = VersionPin::Latest;
        assert_eq!(pin.resolve(&versions), Some(&SemVer::new(2, 0, 0)));

        let pin = VersionPin::Exact(SemVer::new(1, 1, 0));
        assert_eq!(pin.resolve(&versions), Some(&SemVer::new(1, 1, 0)));
    }

    #[test]
    fn resolve_returns_none_for_no_match() {
        let versions = vec![SemVer::new(1, 0, 0)];
        let pin = VersionPin::Exact(SemVer::new(2, 0, 0));
        assert_eq!(pin.resolve(&versions), None);
    }

    #[test]
    fn pin_display_roundtrip() {
        let cases = vec![
            "=1.2.3",
            "~1.2.0",
            "^1.2.0",
            ">=1.0.0 <2.0.0",
            "latest",
        ];
        for s in cases {
            let pin = VersionPin::parse(s).unwrap();
            let rendered = pin.to_string();
            let reparsed = VersionPin::parse(&rendered).unwrap();
            assert_eq!(pin, reparsed, "Roundtrip failed for: {}", s);
        }
    }
}
