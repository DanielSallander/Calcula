//! FILENAME: core/calp/src/workspace_id.rs
//! PURPOSE: Workspace IDENTITY — turn the location string a user configured into
//! a stable scope that a publisher pin can be keyed by.
//! CONTEXT: A TOFU pin used to be keyed by APPLICATION NAME ALONE, so whoever made
//! first contact with a name owned it on the whole machine: an application
//! `acme.finance` served once from `\\evil\share` wrote the pin that the GENUINE
//! `acme.finance` was later measured against, and the real publisher's first
//! legitimate release reported `publisherChanged` — an accusation pointed at the
//! victim. Pins are now keyed by `(namespace, workspace scope, application)`.
//!
//! WHAT A SCOPE IS. `WorkspaceScope::id` is key material: normalized, lossy,
//! lowercase for filesystem locations, never shown to a human. `label` is the
//! location EXACTLY as the user configured it, and is the only string a UI, an
//! audit entry or an error message may display. A lowercased canonical path is
//! not a thing anyone typed and must never be presented as if it were.
//!
//! WHY IMPERFECT CANONICALIZATION IS SAFE HERE. Canonicalization can fail — a
//! UNC path and a mapped drive for one share, a server that is offline, a folder
//! the user renamed. Under plain workspace scoping each of those would be a NEW
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
//! used to OPEN a workspace must be the string used to SCOPE it, or the pin is
//! written under one identity and read under another (the same split-view lesson
//! `verify_and_load_manifest_via` already learned about manifest bytes).

use crate::error::CalpError;

/// The identity a publisher pin is scoped to.
///
/// Deliberately has NO `Default` and is never wrapped in an `Option` on a
/// verification path: a caller that does not know which workspace it is talking to
/// must not compile, for exactly the reason `PinPolicy` has no default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceScope {
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

/// Whether a location string denotes an HTTP(S) workspace.
pub fn is_http_location(location: &str) -> bool {
    let lower = location.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The pointer file that names a workspace, after `.pbip`.
///
/// A workspace IS a directory — this file only makes it selectable in a file
/// dialog, which is far easier to aim at than a folder picker, and makes a
/// workspace self-describing when someone browses the share.
pub const WORKSPACE_MARKER_FILE: &str = "workspace.calcula";

/// Reduce a location that NAMES THE MARKER FILE to the directory holding it.
///
/// `C:\share\ws\workspace.calcula` -> `C:\share\ws`, and likewise for a URL.
/// Any other location is returned unchanged (trimmed).
///
/// THIS MUST RUN BEFORE SCOPING, AND BEFORE OPENING. A publisher pin is filed
/// under the scope derived from the location string, so if the file form scoped
/// differently from the folder form, one user who browsed to the marker and
/// another who typed the folder would hold pins under two identities for one
/// workspace — and the second one would be told a DIFFERENT publisher owns the
/// name, which is the hijack alarm, fired at nobody. Both forms converge here so
/// that cannot happen.
pub fn strip_workspace_marker(location: &str) -> String {
    let trimmed = location.trim();
    // Compare the final segment case-insensitively: Windows paths are
    // case-insensitive, and a file dialog can hand back any casing.
    let cut = trimmed
        .rfind(|c| c == '/' || c == '\\')
        .filter(|&i| trimmed[i + 1..].eq_ignore_ascii_case(WORKSPACE_MARKER_FILE));
    match cut {
        // Keep the separator when everything before it is a root (`C:\`, `/`,
        // `\\server\share`) — cutting it would turn an absolute path relative.
        Some(i) => {
            let head = &trimmed[..i];
            if head.is_empty() || head.ends_with(':') || head.ends_with("//") {
                trimmed[..=i].to_string()
            } else {
                head.to_string()
            }
        }
        None => trimmed.to_string(),
    }
}

/// Are these two location strings the same workspace, for the purpose of a UI
/// prefill or a REFUSAL gate?
///
/// Compares the user's own spelling, case-insensitively and ignoring a trailing
/// separator: the same share reached as `\\srv\reports` and `\\srv\reports\` is
/// one share.
///
/// USE THIS, NOT `workspace_scope(..).id`, on a refusal path. `workspace_scope`
/// returns `Err` for a location it cannot open — and in a gate that refuses, an
/// `Err` resolves to "not a match", i.e. the gate OPENS on malformed input.
/// Trailing-separator and case folding has no failure mode. Where workspace
/// IDENTITY is the question (which pin does this belong to?), scope ids remain
/// the right answer.
///
/// ONE COPY. `WorkingCopyLink::targets` had a private `norm` closure doing
/// exactly this, and the push gate's subscriber check had no comparison at all —
/// it matched on the application NAME alone, so a push to YOUR `sales` was
/// refused because you subscribe to somebody else's `sales`.
pub fn same_workspace(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        s.trim().trim_end_matches(['/', '\\']).to_lowercase()
    }
    norm(a) == norm(b)
}

/// Derive the pin scope for a workspace location.
///
/// Returns `Err` for a location no workspace could be opened from (empty, a
/// non-`http(s)` URL scheme, an HTTP URL carrying a query/fragment/userinfo or a
/// traversing path segment). A location that cannot be scoped must not be usable
/// as a workspace at all — otherwise a pin would be written under a scope derived
/// from one reading of the string and looked up under another.
pub fn workspace_scope(location: &str) -> Result<WorkspaceScope, CalpError> {
    let label = location.trim().to_string();
    if label.is_empty() {
        return Err(CalpError::Workspace(
            "a workspace location must not be empty".to_string(),
        ));
    }
    // The marker file and the directory holding it are ONE workspace, so they
    // must be ONE scope. The label keeps the user's spelling either way.
    let located = strip_workspace_marker(&label);
    // A location carrying a URL scheme Calcula cannot open must be refused here,
    // not quietly treated as a relative filesystem path — `ftp://host/reg` would
    // otherwise scope (and pin) as a folder literally named `ftp:` under the
    // process's working directory.
    if let Some(i) = label.find("://") {
        let scheme = label[..i].to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "file") {
            return Err(CalpError::Workspace(format!(
                "'{label}' is not a usable registry location: only http, https, \
                 file:// and plain filesystem paths are supported"
            )));
        }
    }

    let id = if is_http_location(&located) {
        http_scope_id(&located)?
    } else {
        local_scope_id(&located)?
    };
    Ok(WorkspaceScope { id, label })
}

// ---------------------------------------------------------------------------
// HTTP(S)
// ---------------------------------------------------------------------------

/// `scheme://host[:port]/path`, with the default port folded away, the host
/// lowercased and the PATH CASE PRESERVED.
///
/// Origin-only is deliberately NOT used. A static-file workspace is routinely one
/// directory on a shared host (`https://user.github.io/registry-a` vs
/// `/registry-b`; two teams on one S3 bucket). Reducing to the origin would merge
/// administratively separate workspaces into one scope, re-creating the
/// cross-workspace key substitution that name-only keying got right.
fn http_scope_id(location: &str) -> Result<String, CalpError> {
    let bad = |why: &str| {
        CalpError::Workspace(format!(
            "'{location}' is not a usable workspace URL: {why}"
        ))
    };

    let (scheme, rest) = match location.find("://") {
        Some(i) => (location[..i].to_ascii_lowercase(), &location[i + 3..]),
        None => return Err(bad("expected scheme://host/path")),
    };
    let default_port = match scheme.as_str() {
        "http" => 80u16,
        "https" => 443u16,
        _ => return Err(bad("only http and https workspaces are supported")),
    };

    if rest.contains('?') {
        return Err(bad(
            "a query string is not part of a workspace location (artifact paths \
             are appended to it, so a query could never survive)",
        ));
    }
    if rest.contains('#') {
        return Err(bad("a fragment is not part of a workspace location"));
    }

    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return Err(bad(
            "credentials in the URL are not supported — they would give one \
             workspace two identities depending on whether they were typed",
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
                     name one workspace unambiguously",
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

/// A filesystem workspace's scope id: `file://` stripped, separators normalized,
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
        return Err(CalpError::Workspace(format!(
            "'{location}' does not name a workspace directory"
        )));
    }

    let canonical = std::fs::canonicalize(&separated)
        .ok()
        .map(|p| strip_verbatim_prefix(&p.to_string_lossy()))
        .unwrap_or_else(|| lexical_normalize(&separated));

    let id = canonical.trim().to_lowercase();
    if id.is_empty() {
        return Err(CalpError::Workspace(format!(
            "'{location}' does not name a workspace directory"
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
/// workspace directory that does not exist yet, a UNC server that is offline, a
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
        workspace_scope(location).unwrap().id
    }

    #[test]
    fn every_spelling_of_one_directory_is_one_scope() {
        // A REAL directory, so `canonicalize` participates — this is the case
        // that must converge, because it is the one users actually hit when a
        // workspace is typed two different ways in two different dialogs.
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
                "'{spelling}' must scope to the same workspace as '{base}'"
            );
        }
    }

    #[test]
    fn the_label_is_what_the_user_typed_and_the_id_never_is() {
        let dir = TempDir::new().unwrap();
        let typed = format!("{}\\", dir.path().to_string_lossy().to_uppercase());
        let scope = workspace_scope(&typed).unwrap();
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
            "two sibling workspaces must not share a scope"
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
        // URL paths ARE case-sensitive: /Pub and /pub may be two workspaces.
        assert_ne!(id("https://h/Pub"), id("https://h/pub"));
        assert_eq!(id("https://h/pub/"), id("https://h/pub"));
        assert_eq!(id("https://h//pub//"), "https://h/pub");
        assert_eq!(id("https://h"), "https://h");
    }

    #[test]
    fn two_registries_on_one_host_are_two_scopes() {
        // The reason origin-only keying is refused: GitHub Pages / S3 routinely
        // serve administratively separate workspaces from one origin.
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
                workspace_scope(bad).is_err(),
                "location {bad:?} must be refused, not silently scoped"
            );
        }
    }

    /// THE POINT OF THE MARKER: pointing at the file and pointing at the folder
    /// are ONE workspace, and therefore ONE pin scope.
    ///
    /// If these diverged, a user who browsed to `workspace.calcula` would pin
    /// under a scope nobody else uses, and the next application they subscribed
    /// to from the SAME share under the SAME publisher would come back as
    /// `notPinnedNameConflict` — the hijack warning, fired at a colleague.
    #[test]
    fn the_marker_file_and_its_folder_are_one_scope() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_string_lossy().to_string();
        let expected = id(&base);
        for spelling in [
            format!("{base}\\workspace.calcula"),
            format!("{base}/workspace.calcula"),
            format!("{base}\\WORKSPACE.CALCULA"),
            format!("{base}\\Workspace.Calcula"),
            format!("file://{base}\\workspace.calcula"),
        ] {
            assert_eq!(
                id(&spelling),
                expected,
                "'{spelling}' must scope to the same workspace as '{base}'"
            );
        }
    }

    #[test]
    fn the_marker_stripper_never_cuts_below_a_root() {
        assert_eq!(strip_workspace_marker(r"C:\ws\workspace.calcula"), r"C:\ws");
        assert_eq!(strip_workspace_marker(r"C:\workspace.calcula"), r"C:\");
        assert_eq!(strip_workspace_marker("/workspace.calcula"), "/");
        assert_eq!(
            strip_workspace_marker(r"\\server\share\workspace.calcula"),
            r"\\server\share"
        );
        assert_eq!(
            strip_workspace_marker("https://h/ws/workspace.calcula"),
            "https://h/ws"
        );
        // An origin with no path is a usable workspace location in its own right
        // (`id("https://h") == "https://h"`), so the separator goes.
        assert_eq!(
            strip_workspace_marker("https://h/workspace.calcula"),
            "https://h"
        );
    }

    /// Only the EXACT marker name is a marker. A folder that merely ends in
    /// `.calcula`, or an application whose name resembles it, must be left alone
    /// — stripping those would silently retarget the workspace one level up.
    #[test]
    fn only_the_marker_name_is_stripped() {
        for untouched in [
            r"C:\ws\notworkspace.calcula",
            r"C:\ws\workspace.calcula.bak",
            r"C:\ws\workspace",
            r"C:\my.calcula",
            r"C:\ws",
        ] {
            assert_eq!(
                strip_workspace_marker(untouched),
                untouched,
                "'{untouched}' does not name the marker file and must not be reduced"
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
    /// to `workspace_scope`. Ten app-crate call sites used to run their own
    /// `strip_prefix("file://")` before opening a subscription's workspace, which
    /// handed this function a DIFFERENT string than `pull` had scoped the pin
    /// with. The pin was then written under one identity and read under another,
    /// so `RequirePinned` reported `PublisherNotPinned` and writeback / GATHER /
    /// model-writeback silently went inert.
    ///
    /// This test pins the divergence numerically so the shortcut cannot look
    /// harmless to the next reader: the naive strip does NOT round-trip.
    #[test]
    fn a_locally_pre_stripped_file_url_scopes_to_a_different_registry() {
        // The whole point: the scheme form and the bare form are ONE workspace...
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
            "a hand-stripped file:// URL must not silently scope as the same workspace"
        );

        // The UNC form is worse: hand-stripping turns an absolute share into a
        // path relative to the process working directory.
        let naive_unc = "file://server/share/reg".strip_prefix("file://").unwrap();
        assert_eq!(naive_unc, "server/share/reg");
        assert_eq!(id("file://server/share/reg"), r"\\server\share\reg");
        assert_ne!(id(naive_unc), r"\\server\share\reg");
    }
}
