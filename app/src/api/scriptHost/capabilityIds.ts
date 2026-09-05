//! FILENAME: app/src/api/scriptHost/capabilityIds.ts
// PURPOSE: The SINGLE source of truth for the capability vocabulary — the set
//          of ambient-world capabilities any imperative surface (object script,
//          notebook cell, one-off script, distributed extension, UDF) can be
//          granted. Before Wave 3 this list was duplicated in THREE places
//          (allowlist.ts CapabilityId union, capabilities.ts KNOWN_CAPABILITY_IDS,
//          broker.ts VALID_CAPABILITY_IDS); adding a capability meant editing all
//          three or it failed closed in confusing ways. This leaf module — it
//          imports NOTHING from broker/capabilities/allowlist, so it can never
//          form an import cycle — collapses them to one.
//
// CONTRACT (Rust enforcement): a capability whose grant reaches the BACKEND
// (e.g. net.fetch -> script_http_fetch re-checks the origin per call) needs
// authoritative Rust-side enforcement IN ADDITION to this frontend gate. A
// capability that is purely frontend / in-worker (e.g. formula.udf, which only
// invokes JS already mounted in a worker realm) reaches no Rust gate and needs
// only the entry here.
//
// SO A BACKEND-REACHING CAPABILITY NEEDS **THREE** ENTRIES, NOT ONE:
//   1. this vocabulary (`ALL_CAPABILITY_IDS` below) — otherwise the id is not
//      recognized at all and the broker denies it;
//   2. `RUST_MIRRORED_CAPABILITIES` in app/src/api/scriptHost/capabilities.ts —
//      otherwise consent is recorded in the renderer only and never mirrored, so
//      the Rust gate keeps refusing a capability the user just approved;
//   3. `GRANTABLE_CAPABILITIES` in
//      app/src-tauri/src/scripting/capability_store.rs — otherwise the mirror
//      call is REJECTED by the store's own id allowlist, with the same symptom.
// A frontend-only capability needs (1) alone.
//
// This header used to claim "Rust has NO enumerated capability list, only the
// net.fetch origin store", and told the reader NOT to assume a matching Rust
// entry was needed. That has been false since the capability store gained
// `GRANTABLE_CAPABILITIES`, and the store's own comment names `schedule` as the
// id this exact omission already broke once — a grant that looked approved in
// the UI and was refused by the backend forever after.

/**
 * Every recognized capability id, in one place.
 *  - net.fetch    : HTTPS egress to granted origins (Rust-enforced per call)
 *  - bi.query     : read-only, MODEL-SCOPED queries against the workbook's BI
 *                   connections (measures/groupBy/filters; no raw SQL)
 *  - bi.sql       : read-only RAW SQL against a BI connection's database — a
 *                   HIGHER-TRUST superset of bi.query (can read any table the
 *                   connection's credentials reach); Rust re-validates read-only
 *  - storage      : per-script 256 KB workbook-local key/value store
 *  - ui.html      : render sandboxed HTML inside the object's shape. PAINT
 *                   ONLY — see ui.htmlInput for the other half.
 *  - ui.htmlInput : take the user's input INSIDE that HTML — claim the frame
 *                   (`render.setHitRegions`) so the input lands in the script's
 *                   page instead of in Calcula: rectangle by rectangle on the
 *                   grid, whole card at a time in the Controls pane.
 *
 *                   WHY THIS IS NOT PART OF `ui.html`, which is where it lived
 *                   until M6b. Consent text is a promise, and `ui.html`'s
 *                   promise is "render sandboxed HTML inside the object's
 *                   shape" — four user-facing sentences, in the consent dialog,
 *                   the package inspector, the subscribe dialog and the
 *                   security settings page, and not one of them says the frame
 *                   can also TAKE something. A rectangle claimed with
 *                   `render.setHitRegions` is pointer input removed from the
 *                   grid: inside it the user's click no longer selects a cell,
 *                   it reaches a distributed author's page. That is a
 *                   different question with a different answer — a KPI tile
 *                   that only paints should not have to be granted the ability
 *                   to intercept clicks — and it is exactly the split that made
 *                   `ui.pane` a second id rather than a widening of
 *                   `ui.dialog`.
 *
 *                   BOUNDED BY SHAPE, not by promise. A claim can only ever
 *                   cover pixels the frame already occupies (the rectangles are
 *                   in the frame's OWN coordinates and the shims are placed
 *                   over its clipped box), it is capped in count and validated
 *                   per rectangle (`vHitRegions`), Design Mode suspends every
 *                   claim at once, and `[]` releases the frame completely. On
 *                   the grid it is pointer input only — the host forwards the
 *                   events into the rectangles itself and the frame is INERT
 *                   (hit-transparency alone leaves it in the TAB order), so
 *                   nothing focuses and there is no key stream at all.
 *
 *                   THE OTHER HOST, and the reason that paragraph is scoped to
 *                   the grid. A Controls-pane card renders the same script's
 *                   same document in an ordinary iframe, where a rectangle
 *                   means nothing (the pane lays the card out) and an
 *                   interactive frame can be focused and TYPED into. It honours
 *                   the same gate — hit-transparent AND inert until it claims,
 *                   claimed WHOLE when it does — so `ui.html` still buys paint
 *                   alone on both, and the consent sentence names typing as
 *                   well as clicking because one of the two hosts really does
 *                   hand over the keystrokes. The pane card was interactive on
 *                   the paint grant until that gate was added, which is the
 *                   defect `htmlInputConsentHonesty.test.ts` now watches for on
 *                   EVERY host of such a document.
 *
 *                   Purely frontend / host-mediated (same shape as ui.dialog,
 *                   ui.pane, file.picker, ui.shortcut and grid.read): the gate
 *                   is the broker deciding whether to put shim elements in the
 *                   host window, so there is NO Rust CapabilityStore entry, it
 *                   is NOT in RUST_MIRRORED_CAPABILITIES, and it is asserted
 *                   non-grantable in capability_store.rs. It still belongs in
 *                   the vocabulary (and in the Rust KNOWN_CAPABILITY_IDS)
 *                   because it must be declarable in a signed sidecar
 *                   manifest, consent-visible, and revocable like every other
 *                   id.
 *  - formula.udf  : evaluate a registered user-defined function from a worksheet
 *                   formula (purely frontend/in-worker — NO Rust enforcement; the
 *                   JS impl runs in the owning script's realm through the broker)
 *  - bi.model     : create/update/delete BI model DEFINITIONS (measures,
 *                   relationships, hierarchies, ...) through the consent-gated
 *                   script_bi_model gateway — undoable, audited, rate-limited;
 *                   RLS roles + connections/credentials stay privileged
 *  - bi.connector : register a script-fed data connector (feeds tables into
 *                   the BI model via the host orchestrator; named distinctly
 *                   from net.fetch so consent says what it means)
 *  - ui.dialog    : interrupt the user with a MODAL question and read the
 *                   answer (alert / confirm / prompt / declarative form). The
 *                   dialog itself is rendered by TRUSTED host code — the script
 *                   supplies only data — so this capability buys attention and
 *                   input, never pixels. Purely frontend (no Rust entry): it
 *                   reaches no backend command.
 *  - distribution.writeback
 *                 : fill in and SEND the input cells of a subscribed .calp
 *                   package — read the workbook's writeback regions and drafts,
 *                   save schema-validated drafts, and submit them to the
 *                   publisher's registry. For a script that can also SIGN the
 *                   package it additionally unlocks the publisher side: reading
 *                   every submitter's answers and approving/rejecting them.
 *                   Rust-enforced authoritatively in script_writeback (grant
 *                   re-check + Ed25519 publisher gate + rate buckets + audit).
 *  - schedule     : run one of the script's OWN exposed methods on a recurring
 *                   schedule that survives reload — the Application.OnTime
 *                   replacement. Jobs persist in the WORKBOOK, so this is the
 *                   only capability whose effects outlive the session that
 *                   consented to it; the consent string therefore says the
 *                   quiet part out loud ("without you starting it"). Bounded
 *                   HONESTLY to "while Calcula is open": there is no headless
 *                   runtime, and the capability must never grow one without a
 *                   new consent decision. Rust-enforced authoritatively in
 *                   script_scheduler, which re-checks the grant at EVERY
 *                   firing (a revoke stops a persisted job at the next tick),
 *                   requires the owning script to be mounted, enforces a 30s
 *                   floor and a per-job no-self-overlap guard, and audits
 *                   every fire.
 *  - file.picker  : ask the USER to pick ONE file — to save text into, to
 *                   read text from, to save a rendered PDF into, or to embed
 *                   as a PICTURE. Named for the MECHANISM, not the reach,
 *                   because the mechanism IS the safety story: the script
 *                   never supplies, sees or stores a path; the host opens a
 *                   native picker, the human chooses the file, and the host
 *                   does the I/O, one file per call. ("file.access" was
 *                   rejected as an id — it reads as ambient filesystem
 *                   access, which is exactly the false impression this
 *                   capability must never create.)
 *                   Purely frontend / host-mediated (same shape as ui.dialog):
 *                   the trusted main thread performs the read/write through
 *                   the already-privileged read_text_file / write_text_file
 *                   commands, so there is NO Rust CapabilityStore entry and it
 *                   is NOT in RUST_MIRRORED_CAPABILITIES. The containment that
 *                   matters is that the worker realm has no Tauri, no fs and
 *                   no path vocabulary at all — it can only ask the host to
 *                   ask the user.
 *                   THE PICTURE ARM IS THE NARROWEST OF THE FOUR, and the
 *                   reason it needs no id of its own: the host reads the file,
 *                   proves it is an image from its MAGIC BYTES, enforces the
 *                   byte and pixel caps and stores the bytes INSIDE THE
 *                   DOCUMENT, then hands the script an inert `media:` handle.
 *                   The text arm hands over CONTENTS; this one hands over a
 *                   reference. Same mechanism, same sentence a user already
 *                   consented to, strictly less reach.
 *  - ui.shortcut  : take over ONE keyboard shortcut so pressing it runs one of
 *                   the script's own exposed methods — the Application.OnKey
 *                   replacement. Named for what the user gets (a shortcut),
 *                   never "keyboard": a script never sees the keyboard, only
 *                   the combination it was granted. Bounded structurally, not
 *                   by promise (app/src/api/keybindings.ts): the combination
 *                   must be Ctrl+Shift+<letter> (so typing, Escape, Tab, the
 *                   arrows, F1-F12 and every Ctrl+<key> the grid and the app
 *                   own are unreachable BY SHAPE, not by blocklist), a
 *                   combination anything else already holds is refused rather
 *                   than overridden, the app wins any later tie, at most 8 per
 *                   script, and the binding is listed in the shortcut list and
 *                   dies with the mount. The handler receives `{ combo }` and
 *                   nothing else — there is no key stream to subscribe to.
 *                   Purely frontend / host-mediated (same shape as ui.dialog
 *                   and file.picker): the keydown listener, the registry and
 *                   the dispatch are all trusted main-thread code, so there is
 *                   NO Rust CapabilityStore entry and it is NOT in
 *                   RUST_MIRRORED_CAPABILITIES.
 *  - grid.read    : be SHOWN the contents of the user's cells. Named for what
 *                   the user loses, not for a mechanism, because the mechanism
 *                   is the part that hid it: nothing here is a call the code
 *                   makes. The host PUSHES workbook data into third-party code
 *                   that never asked for a cell by address. THREE paths, and
 *                   every user-facing sentence about this id ENUMERATES them —
 *                   so a fourth path added without a clause makes all of them
 *                   stale by omission, which is the shape of the defect
 *                   `extensionContributions.test.ts` now counts rather than
 *                   keyword-matches:
 *                     1. a cell-style contributor is handed the displayed value
 *                        of every visible cell so it can decide how to paint it;
 *                     2. a subscriber to the cell-change events is handed each
 *                        changed cell's old value, new value and formula;
 *                     3. a field of an add-in's FORM that names a cell (M4) is
 *                        shown that cell's contents, and the value reaches the
 *                        add-in's own code with the user's answers. It is still
 *                        SHOWN, not changed: an add-in's form has no write path
 *                        to a cell at all (extensionFormBindings.ts), which is
 *                        what keeps the last clause of the sentence true.
 *
 *                   SCOPE — read this before applying it anywhere new. This
 *                   capability gates the surfaces where workbook DATA reaches
 *                   code THE USER DID NOT WRITE, i.e. a distributed add-in's
 *                   contributions and event subscriptions. It deliberately does
 *                   NOT gate an OBJECT SCRIPT reading cells (sheet.getRange* /
 *                   api.getCell*): those are pull-style calls the script's own
 *                   author spelled out, they are already governed by the tier
 *                   model (own-sheet at restricted, any sheet at unlocked) and
 *                   by per-package consent for distributed scripts, and
 *                   retrofitting a capability there would force a mass
 *                   re-consent of shipped behavior while buying no containment
 *                   the tier does not already give. Two different questions,
 *                   two different answers:
 *                     "may this script go and read a cell?"   -> tier
 *                     "may this add-in be shown my cells?"    -> grid.read
 *                   The taxonomy (scriptSurfaces.ts) therefore lists grid.read
 *                   ONLY on the sandboxed-extension surface, and the
 *                   object-script row says in prose that grid reads there are
 *                   tier-governed — so the omission cannot be misread as "an
 *                   object script cannot see your cells".
 *
 *                   Purely frontend / host-mediated (same shape as ui.dialog,
 *                   file.picker and ui.shortcut): the gate is the host deciding
 *                   whether to put cell contents into a message, so there is NO
 *                   Rust CapabilityStore entry and it is NOT in
 *                   RUST_MIRRORED_CAPABILITIES. It still belongs in the
 *                   vocabulary (and in KNOWN_CAPABILITY_IDS) because it must be
 *                   declarable in a signed sidecar manifest, consent-visible,
 *                   and revocable like every other id.
 *  - distribution.publish
 *                 : OUTBOUND. Push this workbook to a .calp registry as a
 *                   published package version, UNDER THE USER'S PUBLISHER
 *                   IDENTITY, where other people will pull it. Rust-enforced
 *                   authoritatively in script_distribution.
 *  - distribution.subscribe
 *                 : INBOUND. Bring SOMEBODY ELSE'S published content — sheets,
 *                   object scripts, module scripts, notebooks, model overlays,
 *                   writeback regions — into this workbook, by pulling a
 *                   package or refreshing the ones already subscribed.
 *                   Rust-enforced authoritatively in script_distribution.
 *
 *                   WHY THESE ARE TWO IDS AND NOT ONE "distribution" — read
 *                   this before anyone "simplifies" them together. They are
 *                   different risk classes with different victims:
 *                     outbound puts the USER'S NAME on content OTHER PEOPLE
 *                       will run, signed with the user's Ed25519 key, in a
 *                       place the user cannot recall it from;
 *                     inbound puts OTHER PEOPLE'S CODE in front of the USER.
 *                   A build script that publishes a nightly report has no
 *                   business pulling packages, and a dashboard that refreshes
 *                   its data has no business publishing. One id would have
 *                   forced every consenting user to grant both, and the consent
 *                   sentence could then only have described the union — which
 *                   is the definition of dishonest consent text.
 *
 *                   THREE BOUNDS hold on both, and they are what make these
 *                   grantable at all (app/src-tauri/src/scripting/
 *                   distribution_gateway.rs):
 *                     1. NO CONSENT BY PROXY. A pulled object script still
 *                        lands forced-restricted, distributed and UNMOUNTED;
 *                        module scripts and notebooks still land inert. The
 *                        capability moves DATA, never permission.
 *                     2. ONLY REGISTRIES THE USER CONFIGURED. Every action that
 *                        names a registry is refused unless that location is
 *                        already a saved registry or an existing subscription.
 *                        Adding a registry, and dev-subscribing to a loose
 *                        .cala path, stay human-only — otherwise this is a
 *                        code-delivery channel rather than a capability.
 *                     3. PUBLISHING NEEDS THE KEY, NOT JUST THE GRANT. The
 *                        profile must already hold a publisher keypair (a
 *                        script must never MINT the identity others pin), and
 *                        for an existing package name it must hold THAT
 *                        package's key — the same require_publisher gate the
 *                        writeback review actions pass.
 */
export const ALL_CAPABILITY_IDS = [
  "net.fetch",
  "bi.query",
  "bi.sql",
  "storage",
  "ui.html",
  "formula.udf",
  "bi.model",
  "bi.connector",
  "ui.dialog",
  "distribution.writeback",
  "schedule",
  "file.picker",
  "ui.shortcut",
  "grid.read",
  "distribution.publish",
  "distribution.subscribe",
  // A MODELESS script surface (task pane). Deliberately NOT `ui.dialog`: that
  // id's four user-facing sentences promise "a dialog you must answer or close
  // before continuing", and a pane that stays open beside the grid for hours
  // makes every one of them false. Frontend-only — the host paints the widget
  // tree; there is no Rust gate — so it is absent from RUST_MIRRORED_CAPABILITIES
  // and asserted non-grantable in capability_store.rs. LAST, because the Rust
  // mirror pins order.
  "ui.pane",
  // The INPUT half of `ui.html` (M6b): claiming rectangles of a script's own
  // HTML frame so clicks there reach the script instead of the grid. Split out
  // because ui.html's four user-facing sentences promise painting and nothing
  // else. Frontend-only — the shims are host DOM; there is no Rust gate — so it
  // is absent from RUST_MIRRORED_CAPABILITIES and asserted non-grantable in
  // capability_store.rs. LAST, because the Rust mirror pins order.
  "ui.htmlInput",
] as const;

export type CapabilityId = (typeof ALL_CAPABILITY_IDS)[number];

/**
 * The membership-test set shared by the broker (ceiling filter), the pragma
 * parser, and the consent flow — so an unknown/garbage id from any source can
 * never enter a declared-capability ceiling or grant set.
 */
export const CAPABILITY_ID_SET: ReadonlySet<CapabilityId> = new Set(ALL_CAPABILITY_IDS);

/** Narrowing guard for an untrusted string (manifest field, pragma token, ...). */
export function isCapabilityId(v: unknown): v is CapabilityId {
  return typeof v === "string" && CAPABILITY_ID_SET.has(v as CapabilityId);
}
