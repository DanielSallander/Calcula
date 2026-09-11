# Release pipeline (Windows installers)

Status: **installers build; signing and auto-update are follow-ups.**

**Current as of 2026-08-16.** Re-audited against source. Everything below is accurate except one
line flagged as an open owner question:

- Verified still true: the `bundle` config (`tauri.conf.json:30-32`), the draft-release workflow
  (`release.yml:41` x64, `:44` arm64, `:99` tag guard, `:103` `draft: true`), `workflow_dispatch`
  building without releasing (`:27`), all three manifests agreeing at `0.1.0`, and
  `core/setup-rust-env.ps1 -Target arm64|x64` (default `arm64`, `setup-rust-env.ps1:12-13`).
- Both follow-ups are genuinely **not built**: there is no Windows signing block in
  `tauri.conf.json` (the `"windows"` key there is the *window* array, not bundler signing) and no
  `updater` config or `tauri-plugin-updater` dependency anywhere.
- **`release.yml` is no longer the only workflow.** Four now exist: `release.yml`, `ci.yml`,
  `e2e-nightly.yml`, `architecture-boundaries.yml`.
- **OPEN — owner question:** the claim *"CI cannot run until the repository is pushed to GitHub"*
  could not be verified in this pass (git access was withheld). `.git/config` does declare
  `remote "origin" = https://github.com/DanielSallander/Calcula.git`, and three additional
  workflows have been added since — both consistent with CI being live, but neither proves a push
  happened. Treat that sentence as unverified until the owner confirms.
- The 2026-06 build measurement (16 min, 38 MB MSI / 25 MB NSIS) and the Snapdragon `LNK1120`
  trap are dated, environment-specific observations; not re-measured. The reasoning is the value
  and is preserved as-is.

## What already works

`npm run tauri build` in `app/` produces two installers, because
`tauri.conf.json` has `"bundle": { "active": true, "targets": "all" }`:

- `Calcula_<version>_<arch>_en-US.msi` (WiX)
- `Calcula_<version>_<arch>-setup.exe` (NSIS)

The installer is a **build artifact, not a milestone**: every build packages
whatever is in the tree at that moment. No feature freeze is involved, and new
development flows in automatically. The one thing that does *not* update itself
is the version number (see below).

First verified release build: 16 min, clean, 38 MB MSI / 25 MB NSIS (measured 2026-06; a dated
observation, not re-measured in the 2026-08-16 audit).

## The architecture trap (important)

The primary dev machine is a **Snapdragon X Elite**, so `rustc`'s host triple is
`aarch64-pc-windows-msvc` and a local `tauri build` produces **ARM64-only**
installers. Those will not run on the x64 machines that almost all users have.

**Local x64 cross-compilation does not work as configured.** Attempting
`tauri build --target x86_64-pc-windows-msvc` fails with
`LNK1120: unresolved externals` while linking a *build script* executable:
cargo compiles build scripts for the **host** (arm64) and the crates for the
**target** (x64), but MSVC's `LIB`/`INCLUDE` are single global environment
variables, so only one architecture can be satisfied at a time.

Two ways around it:

1. **Build x64 in CI** (chosen). The `windows-latest` runner is x64 native, so
   there is no cross-compilation at all. Also a clean environment, which catches
   "works on my machine" packaging bugs. See `.github/workflows/release.yml`.
2. **Install the x64 Rust *toolchain*** (not just the target) and build entirely
   under x64 emulation:
   `rustup toolchain install stable-x86_64-pc-windows-msvc` plus an
   x64-consistent MSVC environment. Host and target then match, so nothing is
   cross-compiled. Slower (emulated), but useful if an x64-specific bug ever
   needs local debugging without waiting for CI.

`core/setup-rust-env.ps1` takes `-Target arm64|x64` (default `arm64`, so
existing invocations are unchanged). The x64 mode is what revealed the build
script limitation; it remains useful for pure-Rust cross checks.

## Cutting a release

1. Bump the version in **all three** manifests (they must agree):
   `app/package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`.
2. Tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds x64 + arm64 installers and attaches
   them to a **draft** GitHub Release for review before publishing.

`workflow_dispatch` runs the same build without creating a release, so the
pipeline can be exercised at any time. ~~**CI cannot run until the repository is
pushed to GitHub.**~~ *(Unverified as of 2026-08-16 and probably stale — an `origin` remote is
configured and three further workflows have since been added. See the status header; needs an
owner answer rather than a guess.)*

## The bundled inference runtime (2026-09-10)

The release workflow fetches llama.cpp's `llama-server` (CPU build, one pinned release, sha256 per
architecture — `app/scripts/fetch-llama-server.mjs`) before the build and passes
`--config src-tauri/tauri.runtime-<arch>.conf.json`, which maps the fetched folder to the
`llama-server/` resource folder the app looks in. Why an overlay rather than `tauri.conf.json`:
`bundle.resources` is one static list, a resource glob that matches NOTHING fails the build
(`GlobPathNotFound` in tauri-utils), and each architecture must ship only its own DLLs — so the
per-target mapping lives in a per-target file that only the release build applies. A developer's
`tauri dev` needs no overlay: the debug build looks in `app/src-tauri/binaries/llama-server-<triple>/`
directly, and `npm run tauri …` fetches it first (`pretauri`, `--soft`, so being offline warns and
continues). The model is NOT in the installer — it is downloaded on first use behind a consent
sentence — except in an offline build: put the pinned `.gguf` in `app/src-tauri/models/`
(`npm run fetch:builtin-model`) and build with `tauri.offline-<arch>.conf.json` instead.

## Follow-up 1: code signing

Unsigned installers trigger a Windows SmartScreen "unknown publisher" warning,
which costs a meaningful share of first-time installs. Options, in rough order
of cost:

- **Unsigned** - fine for developers and early adopters; bad for a public launch.
- **OV certificate** - annual cost, requires business identity verification
  (DS Analytics AB qualifies). Removes "unknown publisher", but SmartScreen
  reputation still accrues over download volume.
- **EV certificate** - pricier, hardware token/HSM, grants SmartScreen
  reputation immediately.
- **Azure Trusted Signing** - substantially cheaper subscription, but has
  eligibility rules (including legal-entity age) that must be checked against
  DS Analytics AB before relying on it.

Once a certificate exists, wire it into the Tauri bundler's Windows signing
config and store the credentials as GitHub Actions secrets. Nothing else in the
pipeline changes.

## Follow-up 2: auto-updater

Requires the `tauri-plugin-updater` dependency, an updater signing keypair
(`tauri signer generate` -- the private key becomes a CI secret, the public key
goes in `tauri.conf.json`), and a hosted `latest.json` manifest. GitHub Releases
can host both the manifest and the artifacts.

This is deliberately **not** half-enabled: declaring updater config without the
plugin and keys would break builds. Do it as one contained change.

Note the version discipline: the updater only offers an update when the version
number rises, which is the one part of "new development flows in automatically"
that is manual.
