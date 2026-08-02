# Script Package Manager — registry + shared-library imports

**Date:** 2026-07-31 (design) / 2026-08-01 (first slice implemented)
**Status:** First slice SHIPPED. §10 records what was built, where it DEVIATES from this design,
and the one security limit that remains open. Read §10 before §5-§6: the call shim that shipped is
not the `base.callImport` this document specifies, and the reason matters.
**Answers:** `docs/design/scripting-vba-review.md` roadmap item 14.
**Related:** `docs/design/calp-distribution.md`, `docs/design/wave3-scripting-security.md`,
`docs/design/third-party-addin-authoring.md` (the sibling decision for *extensions*; this doc is
about *scripts and libraries*).

---

## 1. Decision

**Build the registry on `.calp`. Do not build a second distribution system.**

Three decisions, in dependency order:

1. **A library is a `.calp` package of a new `PackageKind::Library`.** It carries module scripts
   and no sheets. It is published, signed, pinned, versioned, resolved, diffed and consented by the
   machinery that already exists in `core/calp/` — `LocalRegistry`, `SemVer`/`VersionPin`,
   Ed25519 + TOFU, content-addressed blobs, and the per-source-hash consent store. No new trust
   primitive is invented.
2. **Imports are declared, not fetched.** A consuming script declares
   `// @uses <alias> <package>@<pin>`; the *host* resolves the alias against a workbook lockfile and
   mounts the library once. A script can never name a target the host did not resolve for it.
3. **A dependency's effective ceiling is the intersection of its own declared ceiling and its
   importer's.** A library can never widen what its consumer could have declared for itself. The
   enforcement point is `buildHandleFromDefinition` (`app/src/api/scriptHost/broker.ts:85-127`) —
   the ceiling handed to it at library-mount time is the intersection — after which `checkPolicy`
   (`broker.ts:158-177`) denies anything above it *before* the grant check, so it is not even
   JIT-promptable.

**One correction to the framing in the roadmap item:** the shim must **not** route through
`callExposedMethod` / `base.callMethod` as-is. Those address a target by
`(objectType, instanceId, methodName)` and authorize cross-origin calls with a *global* `public:
true` flag (`broker.ts:366-390`, `contextShims.ts:317-320`, `allowlist.ts:60`) — a library exported
that way would be callable by every script in the workbook, not just its importers. The relay
*implementation* is reused (`hostCallExposed`, `broker.ts:397-411` — exactly what
`customFunctions.ts:169` already calls); the *addressing and authorization* are new: a
`base.callImport(alias, method, args)` broker method that resolves `alias` against host-side state
belonging to the calling script. Details in §5.

---

## 2. The problem, with evidence

### 2.1 The "Script Marketplace" is a local file exchange, by its own admission

`app/extensions/ScriptableObjects/components/ScriptMarketplace.tsx:1-6`:

```
// PURPOSE: Community script template marketplace.
// CONTEXT: ... Currently works as a local file-based exchange — templates can be exported
//          as .calcula-template files and shared via any file sharing mechanism. A future
//          version could connect to an online registry.
```

The dialog is a drag-and-drop for `.calcula-template` JSON (137-251) plus a hardcoded
"Community Registry (Coming Soon)" placeholder card (269-277). There is no search, no versioning, no
signature check on the imported file, and — notably — **no consent gate**: `handleInstall` (181-190)
calls `saveTemplate` on a file the user dropped, whose `scriptSource` is shown as a 500-character
preview (240-241) and then written to `%APPDATA%/Calcula/templates/`.

### 2.2 Templates are stamp-copies with no link

`app/extensions/ScriptableObjects/lib/templateManager.ts:102-106`:

```ts
/**
 * Stamp a new object script from a template.
 * Creates an independent copy — no live link back to the template.
 */
```

So a bug fixed upstream can never reach the thousand copies stamped from it. There is no update
path because there is nothing to update *from*.

### 2.3 There is no import mechanism, at any granularity

- **Between UDFs in one library:** `generateLibrarySource` (`app/src/api/customFunctions.ts:98-126`)
  emits each function as a separate `context.expose(NAME, async (params) => { body }, { public:
  false })`. No sibling is bound to a name in the generated scope, so a body cannot call another by
  name. *(Honesty note: the arrow closures do capture the enclosing `setup(context)` parameter, and
  `base.callMethod` is restricted-tier with no capability (`allowlist.ts:60`), so
  `context.callMethod("workbook", "__custom_functions__", "OTHER", …)` would plausibly resolve to a
  sibling at runtime — self-calls pass the same-tier/same-origin check in `callExposed`. I did not
  execute this. Either way it is undocumented, untyped, invisible to IntelliSense, and does not
  compose across libraries — so the practical statement "a UDF body cannot call a sibling" stands,
  and if the escape hatch is real it should be either sanctioned or closed, not left ambiguous.)*
- **Between scripts:** `context.callMethod` exists but is a *peer* call, not an import: the target
  must already be mounted, is addressed by object identity, and cross-origin calls require the
  target to be globally `public`.
- **From anywhere external:** nothing. There is no `import`, no `require`, no dependency field in
  any manifest, and no resolution step at mount.

### 2.4 …while the trust layer a registry needs already exists and is in production

| Need | Already shipped | Evidence |
|---|---|---|
| Versioned registry on disk | `LocalRegistry` | `core/calp/src/registry.rs:151-320` (`list_packages`, `get_package_manifest`, `resolve_version`, `list_versions`, `version_exists`) |
| Semver + range pins | `SemVer`, `VersionPin` | `core/calp/src/version.rs:12-160` (`parse`, `matches`, `resolve`) |
| Publisher signing + TOFU pinning | `PublisherKeypair`, `verify_signature`, `pin_publisher` | `core/calp/src/signing.rs:85-287` |
| Content-addressed dedup | blob store | `registry.rs:681-725` (`write_blob`, `read_blob`, `commit_artifacts_as_blobs`) |
| Pre-install review of incoming code | `calp_inspect_package` → `PackageInspection { scripts, module_scripts, … }` | `app/src-tauri/src/calp_commands.rs:2659`, `2559+` |
| Browse a registry from the UI | `calp_browse_registry` | `calp_commands.rs:2511-2556` |
| Per-source-hash consent with diffs | `distributedConsent.ts` | `sha256Hex:50`, `isConsentCurrent:162-186`, `getChangedScripts:202-219`, capability-expansion re-prompt at `86-99`/`181-183` |
| Capability pragma parsing | `parseDeclaredCapabilities` | `app/src/api/scriptHost/capabilities.ts:384-404` |
| Module scripts as a package payload | `PublishedModuleScript` | `core/calp/src/manifest.rs:129-137` |

Everything hard is done. What is missing is a *package kind*, a *resolver*, and a *call shim*.

---

## 3. Library packages

### 3.1 Kind

Add `Library` to `PackageKind` (`core/calp/src/package_kind.rs:9-38`) with
`RefreshDefaults { refresh_formulas: false, refresh_data: false, refresh_structure: false,
preserve_consumer_data: true }` — a library subscription refreshes *nothing* in the workbook; it is
resolved at mount, not merged into the grid. This keeps it out of the override/refresh machinery
entirely, which is the point: a library has no cells.

### 3.2 Payload

A library `.calp` has empty `sheets` and populates `module_scripts`
(`manifest.rs:137`, artifacts at `modules/{id}.json`, `registry.rs:277`). Each module carries:

```jsonc
{
  "id": "stats",                  // module id, stable across versions
  "name": "Statistics helpers",
  "source": "...",                // the module body
  "exports": ["mean", "stdev"],   // declared export names (see §5.2)
  "capabilities": ["bi.query"],   // the module's OWN declared ceiling (pragma-derived)
  "uses": [{ "alias": "fmt", "package": "acme.format", "pin": "^1.2.0" }]  // transitive deps
}
```

`capabilities` must be derived from the source pragmas by `parseDeclaredCapabilities`
(`capabilities.ts:384`) at **publish** time and re-derived at **install** time; if they disagree,
refuse the install. A manifest-declared ceiling that the source does not justify is a
transparency lie, and a source pragma the manifest does not list must not be silently honored.

### 3.3 Status change to be surfaced honestly

Module scripts are documented today as *inert*: "Standalone module scripts bundled with the package
(C8). Unlike object scripts these are inert, transparent data" (`manifest.rs:129-137`), and
`calp_inspect_package` surfaces them "for transparency — they are inert (never auto-executed)"
(`calp_commands.rs` `InspectedModuleScript` doc). **A library package changes that**: its modules
*do* execute, on import. This is a deliberate status change and must be reflected in three places or
the transparency pillar regresses:

1. `PackageInspection` must distinguish `moduleScripts` (inert) from `libraryModules` (executed on
   import), with distinct copy in the pre-pull review UI.
2. The consent prompt must say so in words.
3. `scriptSurfaces.ts` must carry a `library` surface with its real reach. (The review already flags
   this file as understating reach in §6.2; do not add a second omission.)

---

## 4. Registry: search, install, update

### 4.1 Search

`calp_browse_registry` (`calp_commands.rs:2511`) already returns `Vec<PackageInfo>` with every
version. Add:

- `PackageManifest`: `keywords: Vec<String>`, `homepage: Option<String>` (already has `description`,
  `author`, `kind` — `manifest.rs:14-35`).
- `calp_search_registry(registryPath, query, kind: Option<String>) -> Vec<PackageInfo>` — a filter
  over name/description/keywords, `kind`-scoped so the library browser does not list report
  packages. Deliberately a *filter over the existing listing*, not an index: registries are local
  directories and the package count is small. Revisit only if that stops being true.

### 4.2 Install

`library_install(registryPath, package, pin) -> InstalledLibrary`:

1. `LocalRegistry::open` → `resolve_version(package, VersionPin::parse(pin))` (`registry.rs:289`,
   `version.rs:76-160`).
2. Verify the version signature and TOFU-pin the publisher under `lib:<package>` — namespaced
   exactly as extensions use `ext:<id>` (`app/src-tauri/src/lib.rs:3609`) so a library key change
   cannot be mistaken for a report package's.
3. Read the modules and recursively resolve their `uses` into a flattened closure. Cycle detection
   is mandatory and must be a hard error naming the cycle.
4. Return the closure to the frontend for the **consent gate** (§6). Nothing is written and nothing
   is mounted before consent.
5. On consent, write the lockfile (§4.4) and record consent.

### 4.3 Update

`library_check_updates()` re-resolves every lockfile entry's *pin* against the registry and reports
`{ package, current, available, sourceChanged, capabilityChanged }`. `sourceChanged` is a hash
comparison against the consented hashes (`distributedConsent.ts:162-186`); `capabilityChanged` is a
set comparison over the flattened closure. Applying an update re-runs the consent gate and shows a
diff via `getChangedScripts` (`distributedConsent.ts:202-219`) — the existing "review the change,
not a blind re-approval" behaviour, extended to transitive nodes.

**Auto-update is not offered.** A silent version bump that changes executed code is the same failure
mode as a silent source swap, which the consent store exists to prevent.

### 4.4 Lockfile

`.calcula/script-deps.json` in the workbook's virtual filesystem, beside
`.calcula/script-consent.json` (`distributedConsent.ts:17`):

```jsonc
{
  "version": 1,
  "libraries": [
    { "package": "acme.stats", "pin": "^1.2.0", "resolved": "1.2.4",
      "publisherKey": "…", "modules": [{ "id": "stats", "sourceHash": "…" }],
      "uses": [{ "package": "acme.format", "resolved": "1.0.1" }] }
  ]
}
```

Resolution is **from the lockfile**, not from the registry, at mount time. A workbook opened on a
machine whose registry has drifted must either resolve identically or fail loudly — never silently
bind a different version. The registry is consulted only on install and on an explicit update check.

---

## 5. The import mechanism

### 5.1 Declaration

A consuming script declares imports as pragmas, mirroring `// @capability`
(`capabilities.ts:384-404`) so there is one pragma dialect:

```js
// @uses stats acme.stats@^1.2.0
function setup(context) {
  const stats = context.imports.stats;      // typed shim, host-resolved
  context.expose("SUMMARY", async (rangeRef) => {
    const values = await context.range(rangeRef).getValues();
    return await stats.mean(values);        // async — always
  });
}
```

The parser is a sibling of `parseDeclaredCapabilities` with the same "unknown token ⇒ ignore"
discipline. The alias namespace is per-script and local; two scripts may bind different versions of
the same package under the same alias.

### 5.2 Resolution and mount

At mount (`hostMountScript`, `app/src/api/scriptHost/host.ts:307`), the host:

1. Parses `@uses` from the **authoritative** source (the same source whose hash was consented).
2. Resolves each alias against the lockfile. **An alias that is not in the lockfile is a mount
   error**, not a runtime error — a script must not start with a dangling import.
3. Computes the effective ceiling and tier for each library instance (§6.1).
4. Mounts (or reuses) a library realm keyed by
   `(package@resolvedVersion, effectiveCeilingKey, effectiveTier)`.
5. Records `scriptId -> { alias -> libraryHandleKey }` in host-side state. **This map is the
   authorization**: it is built from the consumer's own manifest/pragmas by trusted code and is
   never influenced by anything the script sends.

Each library realm gets its own `ScriptHandle` from `buildHandleFromDefinition`
(`broker.ts:85-127`) with `provenance: "distributed"`, `packageName: <library package>`, and
`declaredCapabilities: <effective ceiling>`. Its capability calls therefore audit as the *library*,
not the consumer — the audit ring already keys on `handle.scriptId` (`broker.ts:209-232`).

### 5.3 The call shim

New broker method, added to `ALLOWLIST` at restricted tier with no capability of its own (the
capability checks happen inside the *library's* handle, which is the point):

```
"base.callImport": { tier: "restricted", class: "emit", validate: vCallImport,
                     desc: "Call a method exported by a declared library dependency" }
```

Host implementation:

```
base.callImport(alias, method, args):
  1. libKey = importMap.get(callerHandle.scriptId)?.get(alias)   // host state, §5.2
     -> not found  => BrokerError("PermissionDenied", "…did not declare '<alias>'")
  2. export must be in the module's declared `exports` list
     -> not found  => BrokerError("UnknownMethod", …)
  3. relay: hostCallExposed(LIB_TYPE, libKey, method, args)      // broker.ts:397
  4. audit: caller scriptId, library package@version, method
```

Step 3 is literally the existing trusted relay — the same one `customFunctions.ts:169` uses. What
changes is that the target is named by the *host's* resolution of the *importer's* declaration, so:

- a script cannot call a library it did not declare;
- a library export is reachable **only** by importers, never by every peer script — which is what
  `{ public: true }` would have meant (`broker.ts:366-390`);
- every cross-package call is attributable in the audit trail, which peer `callMethod` today is not.

`context.imports.<alias>` is a `Proxy` in the worker shim that turns any property access into
`call(rt, "base.callImport", [alias, prop, args])`, so the ergonomics are `await lib.method(...)`
with no registration boilerplate. Generated `.d.ts` for the alias comes from the module's `exports`
list (roadmap item 12's codegen).

**Everything is async.** Structured-clone boundaries cannot be crossed synchronously; a
synchronous library API is not achievable and must be documented as a permanent constraint rather
than worked around. Return values pass through `safeClone`
(`app/src/api/scriptHost/worker/workerHardening.ts`), so exports may return data, never functions,
class instances or closures.

---

## 6. Capability ceilings for imported libraries

### 6.1 The rule and its enforcement point

> **A dependency can never do anything its importer could not have declared for itself.**
>
> `effectiveCeiling(lib, consumer) = declared(lib) ∩ declared(consumer)`
> `effectiveTier(lib, consumer)    = min(tier(lib), tier(consumer))`
> Transitively: `effective(dep) = declared(dep) ∩ effective(parent)`.

**Enforcement point:** the intersection is computed by trusted host code and passed as
`declaredCapabilities` to `buildHandleFromDefinition` (`broker.ts:85-127`) when the library realm is
mounted. From there the existing R19 gate does the work — `checkPolicy` denies an undeclared
capability at `broker.ts:162-168`, *before* the grant check at 171-177, and the comment there
already states the invariant: "denied here (PermissionDenied) before the grant check, so it is also
never JIT-prompted." There is no second place to enforce it and no way for the library's own source
to widen it, because `buildHandleFromDefinition` filters against `CAPABILITY_ID_SET` and takes its
input from the caller, not from the script.

**Why the intersection and not just the library's own ceiling.** Without it you get a classic
confused deputy: a restricted consumer with no `net.fetch` imports `acme.http`, which *does* declare
`net.fetch`, and calls `http.post(url, mySecrets)`. The library performs the egress; the broker sees
the library's handle and allows it; the consumer has escaped its ceiling by composition. The
intersection makes that call fail at the library's own gate, with an error that names the missing
capability — and the fix is for the *consumer* to declare `net.fetch` and be consented for it,
which is exactly the honest outcome.

The converse direction (library borrowing the consumer's grants) is already impossible: grants are
per-`scriptId` (`getGrantSet`, `broker.ts:98`) and the library has its own.

### 6.2 Realm sharing and its cost

Keying realms by `(package@version, ceilingKey, tier)` means consumers with identical effective
permissions share one realm — bounded memory, and module state (caches, connection pools) is shared
where it is safe to share. Two honest costs:

- Peers sharing a realm share module-level state, so a library is a **covert channel between
  same-ceiling consumers**. That is strictly narrower than today's `public: true` peer calls, but it
  is not zero. A `// @uses-isolated` modifier forcing a per-consumer realm should exist for
  libraries handling secrets.
- A library used at many distinct ceilings spawns many realms. Cap the count and fail the mount
  loudly rather than degrading silently.

### 6.3 What a library is never allowed to do

- Declare a capability not in `ALL_CAPABILITY_IDS` (`capabilityIds.ts:62-73`) — filtered at
  `broker.ts:105-112`.
- Raise its own tier. `accessLevel` for a library is `"restricted"` unless the *consumer* is
  unlocked, and `min()` applies.
- Register anything. Libraries export methods; they do not get event hooks, render hooks, UI, or
  formula registration. A library that wants those is an extension — see
  `docs/design/third-party-addin-authoring.md`.

---

## 7. Consent UX for transitive dependencies

Reuse `distributedConsent.ts` unchanged in shape: `ConsentRecord { packageName, scripts[{id,
sourceHash, source}], grantedCapabilities, grantedAt }` (19-42). One record per **library package**,
keyed by resolved version, with every module of that package as a `scripts` entry. The existing
invariants then apply for free: a changed source hash re-prompts (162-186), a capability expansion
re-prompts (86-99, 181-183), and the prompt can diff old→new (202-219).

**The prompt shows the whole closure, in two tiers:**

```
Install  acme.stats 1.2.4                       [signed · Acme Ltd · first use]

  This library will be able to:
      bi.query — run read-only queries against this workbook's data models

  Also installs (required by acme.stats):
      acme.format 1.0.1     signed · Acme Ltd        no capabilities
      tinycsv 0.4.2         UNSIGNED                 no capabilities

  [ Review code ]   [ Install ]   [ Cancel ]
```

Rules that make this honest rather than decorative:

1. **Show the effective ceiling, not the advertised one.** The capability line is
   `declared(lib) ∩ declared(consumer)`. If the consumer cannot do it, do not scare the user with
   it — and if the consumer *can*, the user is approving something real.
2. **Transitive nodes are named and signature-labelled, never hidden behind a count.** "and 7 more"
   is how supply-chain attacks get approved.
3. **Unsigned nodes are called unsigned, in the collapsed list too.** Consistent with the extension
   rule (`ExtensionManager.ts:644-652`) where an unverified signature collapses the ceiling to
   empty, an unsigned library gets an **empty effective ceiling** regardless of what it declared —
   it may compute, it may not reach the world.
4. **One decision, whole closure.** Approving a package approves the exact resolved graph. Any later
   change to any node — new transitive dep, version bump, source change, capability change —
   re-prompts with a diff. Per-node approval would train the user to click through *n* dialogs.
5. **Consent is per workbook.** The store is `.calcula/script-consent.json` inside the `.cala`
   (`distributedConsent.ts:17`), so a library trusted in one workbook is not silently trusted in
   another. (This interacts with roadmap item 16, "trusted-workbook consent persistence" — libraries
   should ride whatever that lands, not invent a parallel persistence.)
6. **The registry is not a trust signal.** Presence in a registry means "published", not "reviewed".
   The prompt must never imply curation.

---

## 8. First slice

**Scope: the import mechanism only, against a local registry, for object scripts and the
Custom Functions library. No marketplace UI.** Rationale: the import shim is the part with no
existing equivalent and the part everything else depends on; the browse UI is a straightforward
consumer of `calp_browse_registry` once the mechanism is real.

1. **`PackageKind::Library`** + `RefreshDefaults` (`core/calp/src/package_kind.rs`), and library
   publish from an existing `.calp` publish path with `sheets` empty.
2. **`library_install` / `library_resolve` Tauri commands** (§4.2) — resolve, verify+TOFU-pin under
   `lib:<package>`, flatten the closure, cycle-detect, return the closure. No mount, no write.
3. **Lockfile** `.calcula/script-deps.json` (§4.4), written only after consent.
4. **`// @uses` pragma parser** in `app/src/api/scriptHost/capabilities.ts`, sibling to
   `parseDeclaredCapabilities`, with unit tests covering: unknown alias, malformed pin, duplicate
   alias, and a pragma inside a string literal (the existing regex is line-anchored and will match
   inside template literals — test the behaviour and document it, do not pretend it parses JS).
5. **Host resolution + realm mount** in `hostMountScript` (`host.ts:307`): build the intersected
   ceiling and tier, mount/reuse the realm, populate the host-side `scriptId -> alias -> libKey` map.
   Mount fails on an unresolved alias.
6. **`base.callImport`** in `allowlist.ts` + `extensionWorkerHost`-style host impl delegating to
   `hostCallExposed` (`broker.ts:397`), plus the `context.imports` Proxy in
   `worker/contextShims.ts` beside `callMethod` (317-320).
7. **Consent gate** reusing `distributedConsent.ts` with the closure-wide prompt of §7.
8. **Tests that are the actual contract:**
   - a library declaring `net.fetch` imported by a consumer that does not → `cap.fetch` denied with
     `PermissionDenied` naming `net.fetch` (this is the confused-deputy test; it is the most
     important test in the slice);
   - an unsigned library → empty effective ceiling;
   - a version bump that changes a module source → re-prompt with a diff;
   - a new transitive dep on update → re-prompt;
   - a script calling an alias it did not declare → `PermissionDenied`;
   - a cycle → hard error naming the cycle;
   - realm dedup: two consumers, same effective ceiling → one realm; different ceilings → two.

**Second slice:** the browser UI — retire `ScriptMarketplace.tsx`'s placeholder card (269-277) and
replace the dialog with a real registry browser (`calp_search_registry` + install + update-check),
reusing the Distribution extension's registry picker. Per project policy (no backward compat), the
`.calcula-template` drag-drop path either routes through the same consent gate or is deleted — it
must not remain as an unconsented side door.

**Third slice:** templates gain a live link. `ObjectTemplate` records
`{ registry, package, version }`; "check for updates" re-resolves and offers a re-stamp with a diff.
The *instance* stays a copy — a remote registry silently rewriting a mounted button script would be
a worse defect than the one it fixes — but the copy now knows where it came from, which is what
`templateManager.ts:102-106` currently cannot say.

---

## 9. What the design author did not verify (2026-07-31)

- I did not run anything. All claims are source reading at the stated file:line positions on `main`
  @ `a9f9018c`.
- **The sibling-call escape hatch in §2.3 is a static reading, not an executed test.** I traced
  closure capture in `generateLibrarySource` and the `sameTrust` branch in `callExposed`, but did
  not confirm that a UDF body can in fact reach a sibling through `context.callMethod`. Resolve this
  before publishing any statement about UDF isolation.
- I did not verify that `LocalRegistry` tolerates a package with zero sheets end-to-end
  (publish → browse → inspect → pull); a library package is the first such artifact and the publish
  path may assume at least one sheet.
- I did not audit `calp_pull` (`calp_commands.rs:1875`) for whether module-script materialization
  would need changes for library packages, or whether libraries should bypass the pull path
  entirely. §3.1 assumes they bypass it; that assumption is untested.
- I did not check whether `SemVer::parse` (`version.rs:24`) accepts pre-release/build metadata. If
  it does not, library versioning inherits that limit.
- The realm-count and covert-channel analysis in §6.2 is reasoning, not measurement.

---

## 10. First slice as built (2026-08-01)

### 10.1 What shipped

| Piece | Where |
|---|---|
| `library_resolve` — the ONE new Tauri command: resolve a pin, verify Ed25519 + TOFU, SHA-256 every module artifact against the signed checksum map, return the sources | `app/src-tauri/src/library_commands.rs` (`resolve_libraries` is the testable core; the command is a window guard + transport construction) |
| `// @uses` / `// @uses-isolated` / `// @export` pragma dialect | `app/src/api/scriptLibraries/usesPragma.ts` |
| The ceiling rule (intersection, tier `min`, transitive chaining, origin intersection) | `app/src/api/scriptLibraries/ceiling.ts` |
| Workbook lockfile `.calcula/script-deps.json` + content-addressed source cache `.calcula/script-libs/<sha256>.js` | `app/src/api/scriptLibraries/lockfile.ts` |
| Search (a filter over the existing `calp_browse_registry`) + transitive closure with cycle and pin-conflict detection | `app/src/api/scriptLibraries/registry.ts` |
| Realm mount, token issue/revoke, generated realm source, generated `imports` prelude | `app/src/api/scriptLibraries/linker.ts` |
| Consent plan / apply / update check / uninstall | `app/src/api/scriptLibraries/install.ts` |
| Per-script `.d.ts` for the `imports` binding | `app/src/api/scriptLibraries/typings.ts` |
| Linking wired into object-script mount | `app/src/api/scriptableObjects.ts` (`ObjectScriptManager.mountScript`) |
| Linking + sibling calls wired into the Custom Functions library | `app/src/api/customFunctions.ts` |
| The registry browser that replaces the placebo | `app/extensions/ScriptableObjects/components/ScriptMarketplace.tsx` |

Tests: `app/src/api/__tests__/scriptLibraries.test.ts` (40), `.../scriptLibraryRegistry.test.ts`
(18), the extended `.../customFunctions.test.ts` (18), and the Rust module tests in
`library_commands.rs` (8).

### 10.2 Deviations from §1-§8, and why

**1. `PackageKind::Library` was NOT added to the enum (§3.1).** `PackageManifest.kind` is already a
free-form `String` with a `"report"` default (`core/calp/src/manifest.rs:20`), so `kind: "library"`
travels and round-trips with no core change at all. `library_resolve` refuses any package whose kind
is not `"library"` before reading a single module. Adding an enum variant would have bought a
`RefreshDefaults` row for a package kind that is never pulled or refreshed.

**2. The TOFU pin is NOT namespaced `lib:<package>` (§4.2 step 2).** Namespacing lives inside
`calp::integrity::verify_manifest_signature_bytes`, which pins by package name. A library IS a
package in the same registry namespace, so a name collision between a library and a report is a
collision of one identity, and pinning them together is correct rather than merely convenient.
Minting a second pin namespace would have meant a second code path through the trust root — the
exact thing the "reuse `calcula-sign` and `install_extension`" rule exists to prevent. The
namespacing that *was* needed is in the CONSENT store, where the key is workbook-local and a report
package named `acme.stats` really could have satisfied a library's consent check; that key is
`lib:<package>` (`scriptLibraries/consentKey.ts`), with a test.

**3. Exports are declared by `// @export` pragmas, not by a manifest field (§3.2).** The manifest
would have been a second, publisher-controlled statement of what the code does, which §3.2 itself
says must be refused when it disagrees with the source. Deriving from the source removes the
disagreement instead of detecting it. Same reasoning for `capabilities` and `uses`: all three are
parsed from the verified source by the frontend, capabilities through the SAME
`parseDeclaredCapabilities` that builds every other script's R19 ceiling.

**4. Unsigned libraries do not get an empty ceiling — they cannot be installed at all (§7 rule 3).**
`verify_and_load_manifest_via` rejects an unsigned package outright (`integrity.rs:430-440`), so
there is no "unsigned but installable" state to give a ceiling to. Strictly stronger than the
design; the UI has no "install anyway" affordance to match.

**5. Resolution is driven from the frontend, one batch per depth level, instead of a Rust-side
recursive flatten (§4.2 step 3).** The dependency edges are `// @uses` pragmas, and a Rust copy of
the pragma parser would be a second implementation of "what does this code declare?" that could
drift from the one the ceiling is built from. Cycle detection, the depth cap (8) and the closure cap
(64 nodes) live in `registry.ts` with tests.

**6. The workbook caches the module SOURCES, not just their hashes (§4.4).** The lockfile alone
cannot answer "what do I mount?" without going back to the registry, which §4.4 forbids at mount
time. Sources are stored content-addressed under their SHA-256 and re-hashed on every read
(`readLockedSource`), so a `.cala` edited outside Calcula fails the mount instead of running
unreviewed code, and a workbook opened on a machine with no registry still behaves identically.

### 10.3 THE OPEN SECURITY LIMIT: the call shim is a bearer token, not a caller-identity check

§1 and §5.3 specify a `base.callImport(alias, method, args)` broker method that resolves the alias
against host-side state keyed by the CALLING handle. That is the right design and it is **not what
shipped**, because it requires `scriptHost/allowlist.ts`, `scriptHost/host.ts` and
`worker/contextShims.ts`, none of which this change owned.

What shipped instead, in `linker.ts`:

* the library realm exposes ONE public method, `__callImport(token, method, args)`;
* it also exposes `__addToken` / `__revokeToken` **non-public**, so only trusted host code reaches
  them (`hostCallExposed` bypasses the cross-origin policy; a script's `callMethod` does not);
* the host issues a fresh 128-bit token per `(realm, consumer)` pair and emits it ONLY into that
  consumer's generated prelude;
* the realm compares tokens without an early exit and routes only `// @export` names.

**What this gives, honestly:**

* a script that did not declare the alias holds no token and is refused with an explicit error
  (tested);
* it cannot mint one: `__addToken` is non-public and every script is cross-origin to the realm
  (tested);
* releasing a consumer revokes its token, and its calls stop working while peers keep theirs
  (tested);
* every call is still a `base.callMethod` through the broker, so it is audited under the caller's
  handle.

**What it does NOT give.** The broker never tells a target who called it, so this is an
object-capability (an unguessable reference), not proof of identity. If an importer leaks its token
to a peer, the peer can call the library within the library's ceiling. That is delegation, not
escalation — the importer could equally proxy the call itself, and the library's ceiling is already
capped at the importer's — but it is a real difference from the specified design, and a token
leaked through a shared channel would not be detectable. **Replacing this with `base.callImport` is
the first follow-up, and it deletes the token entirely rather than layering on it.**

### 10.4 The non-enumerability audit the token design rests on

§10.3's bearer token is only meaningful if a sandboxed script cannot LIST mounted realms or their exposed
methods. That was checked by enumerating every reach surface, not by grepping one list:

* **`ALLOWLIST` rows** (`scriptHost/allowlist.ts`): the only inter-script rows are `base.expose`,
  `base.unexpose` and `base.callMethod`. None lists anything. `api.listObjects` enumerates only
  `SCRIPT_OBJECT_KINDS` = chart, table, pivot, namedRange, slicer, shape (`objectInventory.ts:23-30`)
  — a library realm mounts under `objectType: "workbook"` with a reserved instance and is in no
  object store, so it is not enumerable there.
* **Aspect-dispatched reach with no allowlist row of its own** — `object.getState` / `object.setState`
  (own object only) and the unlocked cross-instance `api.objectGetState` / `api.objectSetState`
  (`vObjectAspect`, `validators.ts:572-584`). These address an object STORE by (objectType, targetId,
  aspect). A library realm is a mounted script, not a store entry, so there is nothing to address and
  no aspect that returns exposed-method names or instance ids.
* **`EXTENSION_BROKER_METHODS`** (`extensionProtocol.ts:410+`): `ext.*` + `cap.*` only. A distributed
  extension cannot call `base.callMethod` at all, so it cannot reach a library realm even with a
  token.
* **The QuickJS op registry** (`core/script-engine/src/ops/`: application, bookmarks,
  canonical_model, cells, extended, model, sheets, utility, worksheet_props): grid/model surface over
  cloned state. No expose, no callMethod, no script enumeration.
* **MCP tools** (`app/src-tauri/src/mcp/server.rs`): grid, sheets, charts, tables, pivots, named
  ranges, BI, audit, plus `draft_object_script` / `list_drafted_scripts` (drafted, never mounted) and
  `run_script` (the isolated QuickJS interpreter). None enumerates mounted realms.
* `listExposed` / `listMountedHandles` (`broker.ts:412`, `478`) are called only by
  `codeInventory.ts` (main-thread transparency UI) and tests — never from a broker method.

So the instance id and the token are host-held values with no enumeration path from a sandboxed
realm. That is what makes the design an object-capability rather than obscurity — and it is also
exactly the property that would silently decay if someone later adds a "list exposed methods"
broker row. If that row is ever added, `base.callImport` must land first.

### 10.5 Two findings from §9 resolved

**The sibling-call escape hatch (§2.3, §9) is REAL, and it was worse than described.** The Custom
Functions library mounted as a LOCAL, RESTRICTED script at the fixed instance id
`"__custom_functions__"`, and so does every user object script — same tier, same origin. So
`callExposed`'s `sameTrust` branch (`broker.ts:382-383`) was satisfied and the `{ public: false }` flag
did nothing between them: any local object script could run
`context.callMethod("workbook", "__custom_functions__", "MYFN", …)` and drive a UDF body holding
whatever capability the user had granted the UDF library (`bi.query`, `net.fetch`) without declaring
anything itself. A confused deputy, reachable from any script in the workbook.

Two changes closed the ambiguity in both directions:

* **Sanctioned:** every UDF is now bound into a `fns` table in the generated source, so a body calls
  a sibling as `await fns.OTHER(x)` — typed, visible, and inside the library's own realm.
* **Closed:** the library's instance id is now a fresh 128-bit random value per install
  (`customFunctions.ts`), held only by trusted host code. A peer script must now guess it. That is
  the same object-capability caveat as §10.3 and it is the strongest fix available without touching
  the broker; the real fix is a caller-identity check in `callExposed`.

**A library realm's `.calp` provenance is `"distributed"` with the LIBRARY's package name.** This
was a choice, not an accident: it gives the realm its own trust origin, which is what makes every
script cross-origin to it, which is what makes `__addToken` unreachable. It also means the realm's
capability calls audit as the library and not as the consumer, which is what §5.2 wanted.

### 10.7 Closing-pass corrections (2026-08-01, Wave H integration)

Three claims in §10.1-§10.5 did not survive re-derivation against the code. Full write-up in
`scripting-vba-review.md` §7.18; the load-bearing summary:

**A. Realm sharing laundered `net.fetch` ORIGINS (HIGH — fixed).** `intersectOrigins` computed the
right narrowed set, but `realmKey` was `package@version | tier | capabilities` and the origins were
resolved *inside* the "mount a new realm" branch. So the first consumer to mount a realm fixed its
origin allowlist for every later sharer: a consumer declaring only `https://b.example` could inherit
a realm granted `https://a.example` and reach a host it never disclosed — enforced authoritatively in
Rust against the *realm's* granted set, so a real escape, not a cosmetic one. `realmKey` now includes
the resolved origin set. **Rule to keep:** every axis of the ceiling belongs in the sharing key, not
just the capability set.

**B. `chainCeiling` had no production caller — transitive dependencies could not run.**
`resolveClosure` walked `// @uses` transitively and `applyInstall` consented and locked every node,
but `mountRealm` compiled a library realm from its own modules alone and never linked *its* imports,
so a dependency's `imports.x` was a `ReferenceError` inside the sandbox. Fail-closed, so not an
escalation — but the design's central transitive rule was untested outside a unit test of the pure
function. `mountRealm` now resolves the locked package's own `uses` first, at
`chainCeiling(declared(dep), effective(parent))` with origins intersected against the **parent's**
resolved set (never the root consumer's), refcounts the dependency realm against the parent realm's
scriptId so release cascades, and refuses a lockfile cycle rather than recursing. Tested end to end
across two realm boundaries, and with the laundering shape (root declares `net.fetch`+`bi.query`,
middle declares only `bi.query`, leaf declares both again → leaf gets `bi.query`).

**C. "A library can never widen its consumer" is about CEILINGS, not GRANTS.** The rule intersects
declared ceilings; the library realm's actual grant comes from the *library's* own install consent,
capped by that intersection. So a consumer that declares `net.fetch` but was never JIT-prompted for
it can still cause egress through a library the user approved for `net.fetch` at install time.
Nothing is granted the user did not approve — they approved it for that library, by name, with its
source shown — but the consumer's own just-in-time prompt is bypassed on that path. Same root cause
as §10.3 and the same fix: `base.callImport` is the only way to gate on the CALLER. `ceiling.ts` now
states this explicitly instead of claiming the stronger property.

### 10.8 Still not done

* `base.callImport` (§10.3) — **the follow-up that matters**, and it now closes two limits rather
  than one: the bearer token *and* the grant-vs-declare gap in §10.7-C.
* Library PUBLISHING: `.calp` publish does not yet emit `kind: "library"` packages, so libraries are
  hand-assembled or published through an existing path with the kind overridden. §8 step 1's publish
  half is not built.
* The `imports` `.d.ts` (`typings.ts`) is generated but not yet injected into the object-script
  editor's Monaco extra-libs.
* ~~Transparency panel does not join the library realms.~~ — **DONE (Wave H closing pass).**
  `codeInventory.ts` lists every locked library module as a `script-library` code unit, showing the
  module's **declared** ceiling next to the live realm's **intersected** grants (the gap between them
  is the narrowing, so both are shown), with the content-addressed cache path so the user can read
  the bytes outside Calcula. A module whose cached source fails its hash is rendered *with the
  failure*, never dropped.
* ~~`scriptSurfaces.ts` has no `library` surface (§3.3 point 3).~~ — **DONE.** Surface id
  `script-library`, worker-realm, author-declared ceiling, with a `gate` string that names all four
  gates (signature + TOFU, consent, version pin, intersected R19) and states the token limit.
* Library resolution pins TOFU on **preview**, not on install: `planInstall` → `resolveClosure` →
  `library_resolve` → `verify_and_load_manifest_via`, which pins on first contact, so browsing a
  registry and cancelling leaves the key pinned. Attended (unlike the extension-scan case that was
  fixed in the same wave) and grants nothing, but it is the same shape.
* Templates still have no live link (§8, third slice).
