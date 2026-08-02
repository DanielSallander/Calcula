# Release pipeline (Windows installers)

Status: **installers build; signing and auto-update are follow-ups.**

## What already works

`npm run tauri build` in `app/` produces two installers, because
`tauri.conf.json` has `"bundle": { "active": true, "targets": "all" }`:

- `Calcula_<version>_<arch>_en-US.msi` (WiX)
- `Calcula_<version>_<arch>-setup.exe` (NSIS)

The installer is a **build artifact, not a milestone**: every build packages
whatever is in the tree at that moment. No feature freeze is involved, and new
development flows in automatically. The one thing that does *not* update itself
is the version number (see below).

First verified release build: 16 min, clean, 38 MB MSI / 25 MB NSIS.

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
pipeline can be exercised at any time. **CI cannot run until the repository is
pushed to GitHub.**

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
