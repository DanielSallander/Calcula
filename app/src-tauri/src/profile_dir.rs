//! FILENAME: app/src-tauri/src/profile_dir.rs
//! PURPOSE: Where the per-user Calcula profile lives (%LOCALAPPDATA%\Calcula),
//! and the guarantee that a TEST never touches the real one.
//! CONTEXT: The profile holds the publisher keypair, the TOFU pin store and the
//! developer anchors (`developer-anchors.json`). Reads of the anchors are not
//! read-only: a passive read that sees a newer co-publisher list RAISES this
//! machine's revision mark. So a host test that reaches a developer door (the
//! authorised reader, the signed base a push compares against, a push) would read
//! -- and change -- the developer's own profile. In a test build this resolves to
//! the directory the test set with [`with_test_profile`], or else to one
//! throwaway profile per test process; the real profile is unreachable.
//!
//! It lives in its own file, not in `calp_commands.rs` beside
//! `calcula_profile_dir`, on purpose: the census tests over `calp_commands.rs`
//! take its production code as everything BEFORE the first `#[cfg(test)]`, so a
//! test-only item near the top of that file would silently shrink every one of
//! them to a few hundred lines.

use std::path::PathBuf;

/// The profile directory: `%LOCALAPPDATA%\Calcula` in the app, a throwaway one
/// in a test build. `calp_commands::calcula_profile_dir` is the name every
/// caller uses.
pub(crate) fn resolve() -> PathBuf {
    #[cfg(test)]
    {
        test_profile::current()
    }
    #[cfg(not(test))]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(local_app_data).join("Calcula")
    }
}

/// Run `f` with the profile directory answering `dir` ON THIS THREAD.
///
/// A thread-local is enough: every developer door a test drives
/// (`open_authorized_content`, `SignedBase`, the publish helpers) runs
/// synchronously on the test's own thread. Restored on the way out, panics
/// included.
#[cfg(test)]
pub(crate) fn with_test_profile<R>(dir: &std::path::Path, f: impl FnOnce() -> R) -> R {
    test_profile::with(dir, f)
}

#[cfg(test)]
mod test_profile {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    thread_local! {
        static OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    /// One throwaway profile for the whole test process, for every test that
    /// sets none.
    static PROCESS_PROFILE: OnceLock<PathBuf> = OnceLock::new();

    pub(super) fn current() -> PathBuf {
        if let Some(dir) = OVERRIDE.with(|o| o.borrow().clone()) {
            return dir;
        }
        PROCESS_PROFILE
            .get_or_init(|| {
                let dir = std::env::temp_dir()
                    .join(format!("calcula-test-profile-{}", std::process::id()));
                // A leftover from an earlier process that had this pid is not
                // this process's state.
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).expect("create the test process's profile");
                // The keypair is minted ONCE, here, before any test runs: tests
                // publish in parallel, and two concurrent `load_or_create`s on an
                // empty profile would each mint a key and one would lose.
                calp::signing::PublisherKeypair::load_or_create(&dir)
                    .expect("mint the test process's publisher key");
                // The approvals key (crate::consent_seal), minted up front for
                // the same reason: every test that records an approval without
                // choosing a profile shares this one "computer".
                crate::consent_seal::get_or_mint_key(&crate::consent_seal::FileKeyStore::new(&dir))
                    .expect("mint the test process's approvals key");
                dir
            })
            .clone()
    }

    pub(super) fn with<R>(dir: &Path, f: impl FnOnce() -> R) -> R {
        struct Restore(Option<PathBuf>);
        impl Drop for Restore {
            fn drop(&mut self) {
                let previous = self.0.take();
                OVERRIDE.with(|o| *o.borrow_mut() = previous);
            }
        }
        let previous = OVERRIDE.with(|o| o.borrow_mut().replace(dir.to_path_buf()));
        let _restore = Restore(previous);
        f()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No test reaches the developer's real profile: inside
    /// `with_test_profile` the profile IS the directory the test chose (and is
    /// restored after), and outside it is a throwaway one -- never
    /// `%LOCALAPPDATA%\Calcula`.
    ///
    /// SABOTAGE: make `current()` ignore `OVERRIDE` (the host anchor tests go
    /// red too: the anchor they recorded is not where the door looks).
    #[test]
    fn tests_never_touch_the_real_profile() {
        let chosen = tempfile::TempDir::new().unwrap();
        let outside = crate::calp_commands::calcula_profile_dir();
        let inside = with_test_profile(chosen.path(), crate::calp_commands::calcula_profile_dir);
        assert_eq!(inside, chosen.path(), "the override is not what the profile resolves to");
        assert_eq!(
            crate::calp_commands::calcula_profile_dir(),
            outside,
            "the override leaked out of with_test_profile"
        );
        let nested = with_test_profile(chosen.path(), || {
            let other = tempfile::TempDir::new().unwrap();
            let deeper = with_test_profile(other.path(), crate::calp_commands::calcula_profile_dir);
            assert_eq!(deeper, other.path());
            crate::calp_commands::calcula_profile_dir()
        });
        assert_eq!(nested, chosen.path(), "a nested override did not restore the outer one");

        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let real = PathBuf::from(local).join("Calcula");
            assert_ne!(outside, real, "a test resolved the developer's real profile");
            assert!(!outside.starts_with(&real), "a test resolved inside the real profile");
        }
        assert!(
            calp::signing::PublisherKeypair::load_existing(&outside).unwrap().is_some(),
            "the process profile's keypair is minted up front"
        );
    }
}
