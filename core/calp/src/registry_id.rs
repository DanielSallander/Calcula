//! FILENAME: core/calp/src/registry_id.rs
//! PURPOSE: Registry IDENTITY — turn the location string a user configured into
//! a stable scope that a publisher pin can be keyed by.
//! CONTEXT: A TOFU pin used to be keyed by PACKAGE NAME ALONE, so whoever made
//! first contact with a name owned it on the whole machine: a package
//! `acme.finance` served once from `\\evil\share` wrote the pin that the GENUINE
//! `acme.finance` was later measured against, and the real publisher's first
//! legitimate release reported `publisherChanged` — an accusation pointed at the
//! victim. Pins are now keyed by `(namespace, registry scope, package)`.
//!
//! WHAT A SCOPE IS. `RegistryScope::id` is key material: normalized, lossy,
//! lowercase for filesystem locations, never shown to a human. `label` is the
//! location EXACTLY as the user configured it, and is the only string a UI, an
//! audit entry or an error message may display. A lowercased canonical path is
//! not a thing anyone typed and must never be presented as if it were.
//!
//! WHY IMPERFECT CANONICALIZATION IS SAFE HERE. Canonicalization can fail — a
//! UNC path and a mapped drive for one share, a server that is offline, a folder
//! the user renamed. Under plain registry scoping each of those would be a NEW
//! scope and therefore a silent first use. It is not, because `integrity.rs`
//! cross-checks every first contact against pins for the same name in OTHER
//! scopes: a failed canonicalization lands in the same-key branch and reports
//! `FirstUseKnownPublisher` ("the publisher you already trust, reached from a new
//! location"). Canonicalization is an OPTIMIZATION; the cross-scope check is the
//! correctness backstop. The worst outcome of a miss is one redundant pin row and
//! one reassuring notice — never a false hijack alarm, and never a silent accept
//! of a DIFFERENT key.
//!
//! THE SCOPE IS DERIVED FROM THE LOCATION STRING THE USER CONFIGURED — never from
//! the transport. `managed_policy`'s admin pre-pin has no transport at all; an
//! HTTP transport's self-reported identity is server-influenced; and the string
//! used to OPEN a registry must be the string used to SCOPE it, or the pin is
//! written under one identity and read under another (the same split-view lesson
//! `verify_and_load_manifest_via` already learned about manifest bytes).

use crate::error::CalpError;

/// The identity a publisher pin is scoped to.
///
/// Deliberately has NO `Default` and is never wrapped in an `Option` on a
/// verification path: a caller that does not know which registry it is talking to
/// must not compile, for exactly the reason `PinPolicy` has no default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryScope {
    /// Normalized key material. Lowercased for filesystem locations (Windows
    /// paths are case-insensitive); case-preserving for HTTP paths (URL paths
    /// are case-sensitive). NEVER display this.
    pub id: String,
    /// The location string exactly as the user configured it. The ONLY form that
    /// may appear in a UI, an error message or an audit entry.
    pub label: String,
}

/// The one `file://` stripper for the whole codebase.
///
/// Two divergent copies used to exist (`calp_registry::open_registry` stripped
/// the prefix; `managed_policy::local_registry_path` stripped the prefix AND all
/// leading slashes), which meant the org skin could be pinned under one spelling
/// and read under another. Forms handled:
///
///   * `file:///C:/reg`      -> `C:/reg`          (empty authority + drive path)
///   * `file://C:/reg`       -> `C:/reg`          (the form `format!("file://{}")` produces)
///   * `file://server/share` -> `\\server\share`  (authority = UNC host)
///   * `file:///srv/reg`     -> `/srv/reg`        (empty authority + rooted path)
///
/// A location with no `file://` prefix is returned unchanged.
pub fn strip_file_scheme(location: &str) -> String {
    let Some(rest) = location.strip_prefix("file://") else {
        return location.to_string();
    };
    let without_slashes = rest.trim_start_matches('/');
    if looks_like_drive_path(without_slashes) {
        return without_slashes.to_string();
    }
    if rest.starts_with('/') {
        // Empty authority: what follows is a rooted path, keep exactly one root.
        return format!("/{}", without_slashes);
    }
    // A non-empty authority is a UNC host.
    format!(r"\\{}", rest.replace('/', "\\"))
}

/// `C:...` / `c:/...` — a Windows drive-qualified path.
fn looks_like_drive_path(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Whether a location string denotes an HTTP(S) registry.
pub fn is_http_location(location: &str) -> bool {
    let lower = location.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Derive the pin scope for a registry location.
///
/// Returns `Err` for a location no registry could be opened from (empty, a
/// non-`http(s)` URL scheme, an HTTP URL carrying a query/fragment/userinfo or a
/// traversing path segment). A location that cannot be scoped must not be usable
/// as a registry at all — otherwise a pin would be written under a scope derived
/// from one reading of the string and looked up under another.
pub fn registry_scope(location: &str) -> Result<RegistryScope, CalpError> {
    let label = location.trim().to_string();
    if label.is_empty() {
        return Err(CalpError::Registry(
            "a registry location must not be empty".to_string(),
        ));
    }
    // A location carrying a URL scheme Calcula cannot open must be refused here,
    // not quietly treated as a relative filesystem path — `ftp://host/reg` would
    // otherwise scope (and pin) as a folder literally named `ftp:` under the
    // process's working directory.
    if let Some(i) = label.find("://") {
        let scheme = label[..i].to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "file") {
            return Err(CalpError::Registry(format!(
                "'{label}' is not a usable registry location: only http, https, \
                 file:// and plain filesystem paths are supported"
            )));
        }
    }

    let id = if is_http_location(&label) {
        http_scope_id(&label)?
    } else {
        local_scope_id(&label)?
    };
    Ok(RegistryScope { id, label })
}

// ---------------------------------------------------------------------------
// HTTP(S)
// ---------------------------------------------------------------------------

/// `scheme://host[:port]/path`, with the default port folded away, the host
/// lowercased and the PATH CASE PRESERVED.
///
/// Origin-only is deliberately NOT used. A static-file registry is routinely one
/// directory on a shared host (`https://user.github.io/registry-a` vs
/// `/registry-b`; two teams on one S3 bucket). Reducing to the origin would merge
/// administratively separate registries into one scope, re-creating the
/// cross-registry key substitution that name-only keying got right.
fn http_scope_id(location: &str) -> Result<String, CalpError> {
    let bad = |why: &str| {
        CalpError::Registry(format!(
            "'{location}' is not a usable registry URL: {why}"
        ))
    };

    let (scheme, rest) = match location.find("://") {
        Some(i) => (location[..i].to_ascii_lowercase(), &location[i + 3..]),
        None => return Err(bad("expected scheme://host/path")),
    };
    let default_port = match scheme.as_str() {
        "http" => 80u16,
        "https" => 443u16,
        _ => return Err(bad("only http and https registries are supported")),
    };

    if rest.contains('?') {
        return Err(bad(
            "a query string is not part of a registry location (artifact paths \
             are appended to it, so a query could never survive)",
        ));
    }
    if rest.contains('#') {
        return Err(bad("a fragment is not part of a registry location"));
    }

    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return Err(bad(
            "credentials in the URL are not supported — they would give one \
             registry two identities depending on whether they were typed",
        ));
    }
    if authority.is_empty() {
        return Err(bad("no host"));
    }

    // Split host / port, IPv6-literal aware (`[::1]:8080`).
    let (host, port) = if let Some(close) = authority.find(']') {
        let (h, tail) = authority.split_at(close + 1);
        match tail.strip_prefix(':') {
            Some(p) => (h, Some(p)),
            None if tail.is_empty() => (h, None),
            None => return Err(bad("malformed host")),
        }
    } else {
        match authority.rfind(':') {
            Some(i) => (&authority[..i], Some(&authority[i + 1..])),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return Err(bad("no host"));
    }
    // IDN / punycode is passed through exactly as typed — no unicode folding, so
    // a homograph stays a DISTINCT scope rather than merging with its lookalike.
    let host = host.to_ascii_lowercase();

    let port_suffix = match port {
        None => String::new(),
        Some(p) => {
            let parsed: u16 = p
                .parse()
                .map_err(|_| bad("the port is not a number"))?;
            if parsed == default_port {
                String::new()
            } else {
                format!(":{parsed}")
            }
        }
    };

    // Path: collapse separator runs, drop the trailing slash, refuse traversal.
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" => {}
            "." | ".." => {
                return Err(bad(
                    "a '.' or '..' path segment is not allowed — the scope must \
                     name one registry unambiguously",
                ))
            }
            s => segments.push(s),
        }
    }
    let path_id = if segments.is_empty() {
        String::new()
    } else {
        format!("/{}", segments.join("/"))
    };

    Ok(format!("{scheme}://{host}{port_suffix}{path_id}"))
}

// ---------------------------------------------------------------------------
// Filesystem / UNC
// ---------------------------------------------------------------------------

/// A filesystem registry's scope id: `file://` stripped, separators normalized,
/// `canonicalize`d when the OS can (which is what merges a junction, a `subst`
/// drive and the real path), lexically normalized when it cannot, and lowercased
/// because Windows paths are case-insensitive.
fn local_scope_id(location: &str) -> Result<String, CalpError> {
    let stripped = strip_file_scheme(location);
    let separated = stripped.replace('/', "\\");
    // A location that is nothing but separators (`file://`, `\\`, `/`) names no
    // directory. Refusing it here is what stops it from scoping — and pinning —
    // as the bare root.
    if separated
        .trim()
        .trim_matches(|c| c == '\\' || c == '/')
        .is_empty()
    {
        return Err(CalpError::Registry(format!(
            "'{location}' does not name a registry directory"
        )));
    }

    let canonical = std::fs::canonicalize(&separated)
        .ok()
        .map(|p| strip_verbatim_prefix(&p.to_string_lossy()))
        .unwrap_or_else(|| lexical_normalize(&separated));

    let id = canonical.trim().to_lowercase();
    if id.is_empty() {
        return Err(CalpError::Registry(format!(
            "'{location}' does not name a registry directory"
        )));
    }
    Ok(id)
}

/// `\\?\C:\reg` -> `C:\reg`, `\\?\UNC\server\share` -> `\\server\share`.
/// The verbatim prefix is an OS artifact of `canonicalize`, not part of the
/// user's identity for the location.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// Textual normalization for a location `canonicalize` could not resolve: a
/// registry directory that does not exist yet, a UNC server that is offline, a
/// path the process cannot stat.
///
/// Absolutizes against the process cwd, resolves `.`/`..` textually, collapses
/// separator runs, and strips trailing separators without ever cutting below a
/// root (`C:\` stays `C:\`; `\\server\share` stays `\\server\share`).
fn lexical_normalize(path: &str) -> String {
    let path = path.trim_end_matches(' ');

    // Absolutize a relative path against the current directory, so `reg` and
    // `.\reg` cannot become two scopes for one folder.
    let absolute: String = if is_absolute_windowsish(path) {
        path.to_string()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => format!("{}\\{}", cwd.to_string_lossy().trim_end_matches('\\'), path),
            Err(_) => path.to_string(),
        }
    };

    // Split off the root, which `..` may never climb past.
    let (root, rest, locked) = if let Some(tail) = absolute.strip_prefix(r"\\") {
        // \\server\share\... — server and share are part of the root.
        (r"\\".to_string(), tail.to_string(), 2usize)
    } else if looks_like_drive_path(&absolute) {
        (
            format!("{}\\", &absolute[..2]),
            absolute[2..].trim_start_matches('\\').to_string(),
            0usize,
        )
    } else if let Some(tail) = absolute.strip_prefix('\\') {
        ("\\".to_string(), tail.to_string(), 0usize)
    } else {
        (String::new(), absolute.clone(), 0usize)
    };

    let mut out: Vec<&str> = Vec::new();
    for segment in rest.split('\\') {
        match segment {
            "" | "." => {}
            ".." => {
                if out.len() > locked {
                    out.pop();
                }
            }
            s => out.push(s),
        }
    }
    format!("{}{}", root, out.join("\\"))
}

fn is_absolute_windowsish(path: &str) -> bool {
    looks_like_drive_path(path) || path.starts_with('\\') || path.starts_with('/')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn id(location: &str) -> String {
        registry_scope(location).unwrap().id
    }

    #[test]
    fn every_spelling_of_one_directory_is_one_scope() {
        // A REAL directory, so `canonicalize` participates — this is the case
        // that must converge, because it is the one users actually hit when a
        // registry is typed two different ways in two different dialogs.
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_string_lossy().to_string();
        let forward = base.replace('\\', "/");

        let expected = id(&base);
        for spelling in [
            base.clone(),
            forward.clone(),
            format!("{base}\\"),
            format!("{forward}/"),
            base.to_uppercase(),
            format!("file://{base}"),
            format!("file:///{forward}"),
            format!(r"\\?\{base}"),
            format!("{base}\\.\\"),
            format!("{base}\\sub\\.."),
        ] {
            assert_eq!(
                id(&spelling),
                expected,
                "'{spelling}' must scope to the same registry as '{base}'"
            );
        }
    }

    #[test]
    fn the_label_is_what_the_user_typed_and_the_id_never_is() {
        let dir = TempDir::new().unwrap();
        let typed = format!("{}\\", dir.path().to_string_lossy().to_uppercase());
        let scope = registry_scope(&typed).unwrap();
        assert_eq!(scope.label, typed.trim(), "the label is the user's spelling");
        assert_ne!(scope.id, scope.label);
        assert_eq!(scope.id, scope.id.to_lowercase());
    }

    #[test]
    fn distinct_local_registries_stay_distinct() {
        let dir = TempDir::new().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        assert_ne!(
            id(&a.to_string_lossy()),
            id(&b.to_string_lossy()),
            "two sibling registries must not share a scope"
        );
    }

    #[test]
    fn a_registry_that_does_not_exist_yet_still_scopes_lexically() {
        // canonicalize fails here; the lexical fallback must still be stable and
        // still converge across spellings.
        let a = id(r"C:\no-such-registry\Reg");
        let b = id(r"c:/no-such-registry/reg/");
        let c = id(r"C:\no-such-registry\x\..\Reg");
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(a, r"c:\no-such-registry\reg");
    }

    #[test]
    fn a_drive_root_never_collapses_to_nothing() {
        assert_eq!(id(r"C:\"), r"c:\");
        assert_eq!(id(r"C:\a\..\..\.."), r"c:\");
    }

    #[test]
    fn unc_paths_keep_their_root() {
        assert_eq!(id(r"\\server\share\reg"), r"\\server\share\reg");
        assert_eq!(id(r"\\server\share\reg\"), r"\\server\share\reg");
        assert_eq!(id(r"\\SERVER\Share\Reg"), r"\\server\share\reg");
        assert_eq!(id("file://server/share/reg"), r"\\server\share\reg");
        // `..` may not climb out of \\server\share.
        assert_eq!(id(r"\\server\share\a\..\..\.."), r"\\server\share");
    }

    #[test]
    fn http_folds_the_default_port_and_lowercases_the_host() {
        assert_eq!(id("https://REG.Acme.com/pub"), "https://reg.acme.com/pub");
        assert_eq!(id("https://reg.acme.com:443/pub"), "https://reg.acme.com/pub");
        assert_eq!(id("http://reg.acme.com:80/pub"), "http://reg.acme.com/pub");
        // A non-default port is part of the identity.
        assert_eq!(id("https://reg.acme.com:8443/pub"), "https://reg.acme.com:8443/pub");
        // http and https are different scopes.
        assert_ne!(id("http://reg.acme.com/pub"), id("https://reg.acme.com/pub"));
    }

    #[test]
    fn http_paths_are_case_sensitive_and_slash_normalized() {
        // URL paths ARE case-sensitive: /Pub and /pub may be two registries.
        assert_ne!(id("https://h/Pub"), id("https://h/pub"));
        assert_eq!(id("https://h/pub/"), id("https://h/pub"));
        assert_eq!(id("https://h//pub//"), "https://h/pub");
        assert_eq!(id("https://h"), "https://h");
    }

    #[test]
    fn two_registries_on_one_host_are_two_scopes() {
        // The reason origin-only keying is refused: GitHub Pages / S3 routinely
        // serve administratively separate registries from one origin.
        assert_ne!(
            id("https://user.github.io/registry-a"),
            id("https://user.github.io/registry-b")
        );
    }

    #[test]
    fn unusable_locations_are_refused_rather_than_guessed() {
        for bad in [
            "",
            "   ",
            "ftp://host/reg",
            "https://host/reg?token=1",
            "https://host/reg#frag",
            "https://user:pw@host/reg",
            "https:///reg",
            "https://host/a/../b",
            "https://host/./b",
            "https://host:notaport/reg",
            "file://",
        ] {
            assert!(
                registry_scope(bad).is_err(),
                "location {bad:?} must be refused, not silently scoped"
            );
        }
    }

    #[test]
    fn the_file_scheme_stripper_handles_every_form() {
        assert_eq!(strip_file_scheme(r"file://C:\reg"), r"C:\reg");
        assert_eq!(strip_file_scheme("file:///C:/reg"), "C:/reg");
        assert_eq!(strip_file_scheme("file://server/share"), r"\\server\share");
        assert_eq!(strip_file_scheme("file:///srv/reg"), "/srv/reg");
        assert_eq!(strip_file_scheme(r"C:\reg"), r"C:\reg");
    }

    /// WHY A CALLER MUST NEVER PRE-STRIP `file://` ITSELF.
    ///
    /// A publisher pin is filed under the scope derived from the string handed
    /// to `registry_scope`. Ten app-crate call sites used to run their own
    /// `strip_prefix("file://")` before opening a subscription's registry, which
    /// handed this function a DIFFERENT string than `pull` had scoped the pin
    /// with. The pin was then written under one identity and read under another,
    /// so `RequirePinned` reported `PublisherNotPinned` and writeback / GATHER /
    /// model-writeback silently went inert.
    ///
    /// This test pins the divergence numerically so the shortcut cannot look
    /// harmless to the next reader: the naive strip does NOT round-trip.
    #[test]
    fn a_locally_pre_stripped_file_url_scopes_to_a_different_registry() {
        // The whole point: the scheme form and the bare form are ONE registry...
        assert_eq!(id("file:///C:/no-such-reg/pub"), id("C:/no-such-reg/pub"));
        assert_eq!(id(r"file://C:\no-such-reg\pub"), id(r"C:\no-such-reg\pub"));

        // ...but what a naive `strip_prefix("file://")` leaves behind is not.
        let naive = "file:///C:/no-such-reg/pub"
            .strip_prefix("file://")
            .unwrap();
        assert_eq!(naive, "/C:/no-such-reg/pub");
        assert_ne!(
            id(naive),
            id("file:///C:/no-such-reg/pub"),
            "a hand-stripped file:// URL must not silently scope as the same registry"
        );

        // The UNC form is worse: hand-stripping turns an absolute share into a
        // path relative to the process working directory.
        let naive_unc = "file://server/share/reg".strip_prefix("file://").unwrap();
        assert_eq!(naive_unc, "server/share/reg");
        assert_eq!(id("file://server/share/reg"), r"\\server\share\reg");
        assert_ne!(id(naive_unc), r"\\server\share\reg");
    }
}
