// FILENAME: app/extensions/ModelEditor/components/sections/__tests__/restSourceForm.test.ts
// PURPOSE:  The REST source form's pure half — the seeded variants, the body
//           normalization, and the Save gate.
//
// WHY THIS FILE EXISTS. A `RestSourceConfigDto` is handed to Rust and
// deserialized STRAIGHT into `RestSourceConfig` with `serde_json::from_value`.
// There is no lenient middle layer: a field the form omits that the engine
// declares as a plain (non-`Option`, no `serde(default)`) field is not a
// validation message, it is `missing field 'size'` — a raw serde error, on the
// Save the user just pressed, about a box that was showing "100" the whole
// time. Every assertion here is about the form writing DOWN what it shows, and
// about `restConfigProblems` refusing before serde has to.
//
// The engine's own rules live in
// `model-engine-lib/crates/engine-core/src/model/rest/` — `endpoint.rs` for the
// pagination variants, `auth_spec.rs` for the auth variants, `validate.rs` for
// what each one must contain.

import { describe, expect, it } from "vitest";
import type { RestEndpointDto, RestSourceConfigDto } from "@api";
import {
  declaredSlots,
  defaultAuth,
  defaultPagination,
  emptyRestConfig,
  normalizeBody,
  paginationProblems,
  restConfigProblems,
  withMethod,
} from "../RestSourceForm";

/** A config that is otherwise fine, so a test's own endpoint is the only fault. */
function configWith(endpoints: RestEndpointDto[]): RestSourceConfigDto {
  return { ...emptyRestConfig(), baseUrl: "https://api.example.com/v1", endpoints };
}

function endpoint(overrides: Partial<RestEndpointDto> = {}): RestEndpointDto {
  return { name: "orders", path: "v1/orders", method: "get", ...overrides };
}

// ---------------------------------------------------------------------------
// Pagination — the seeded variant
// ---------------------------------------------------------------------------

describe("defaultPagination", () => {
  it("seeds every field the engine's pageSize variant declares", () => {
    // RestPagination::PageSize { page_param, size_param, size, max_pages } —
    // all four mandatory, none with a serde default.
    expect(defaultPagination("pageSize")).toEqual({
      mode: "pageSize",
      pageParam: "page",
      sizeParam: "per_page",
      size: 100,
      maxPages: 50,
    });
  });

  it("seeds every field the engine's offset variant declares", () => {
    expect(defaultPagination("offset")).toEqual({
      mode: "offset",
      offsetParam: "offset",
      limitParam: "limit",
      limit: 100,
      maxPages: 50,
    });
  });

  it("seeds the cursor variant, leaving only the response-shaped path blank", () => {
    // `cursor_path` cannot be guessed from anything the form knows, so it is
    // seeded PRESENT but empty and reported as a problem until it is named.
    expect(defaultPagination("cursor")).toEqual({
      mode: "cursor",
      cursorParam: "cursor",
      cursorPath: "",
      maxPages: 50,
    });
  });

  it("seeds the link-header variant, which carries only a ceiling", () => {
    expect(defaultPagination("linkHeader")).toEqual({ mode: "linkHeader", maxPages: 50 });
  });

  it("clears every other field for the unit variant 'none'", () => {
    // `RestPagination::None` is a unit variant: leftovers from another mode
    // would be dead weight persisted into the model file.
    expect(defaultPagination("none")).toEqual({ mode: "none" });
  });

  it("every seeded paginating mode passes the form's own gate", () => {
    // The regression in one line: accepting the displayed defaults used to
    // produce `{"mode":"pageSize","pageParam":"page","sizeParam":"size"}` and
    // fail the save with `missing field 'size'`.
    for (const mode of ["pageSize", "offset", "linkHeader"]) {
      const problems = restConfigProblems(
        configWith([endpoint({ pagination: defaultPagination(mode) })]),
      );
      expect(problems, `mode '${mode}' is refused by the form as seeded`).toEqual([]);
    }
  });

  it("seeded cursor paging asks for the one thing it cannot guess", () => {
    const problems = restConfigProblems(
      configWith([endpoint({ pagination: defaultPagination("cursor") })]),
    );
    expect(problems).toEqual(["Endpoint 'orders': a path to the next cursor is required to paginate."]);
  });
});

// ---------------------------------------------------------------------------
// Pagination — the Save gate
// ---------------------------------------------------------------------------

describe("paginationProblems", () => {
  it("says nothing about a single-request endpoint", () => {
    expect(paginationProblems("orders", undefined)).toEqual([]);
    expect(paginationProblems("orders", { mode: "none" })).toEqual([]);
  });

  it("reports the tag-only pageSize mode that used to reach serde", () => {
    const problems = paginationProblems("orders", { mode: "pageSize" });
    expect(problems).toContain("Endpoint 'orders': a page parameter is required to paginate.");
    expect(problems).toContain("Endpoint 'orders': a size parameter is required to paginate.");
    expect(problems).toContain("Endpoint 'orders': the page size must be at least 1.");
    expect(problems).toContain("Endpoint 'orders': the page ceiling must be at least 1.");
  });

  it("reports the tag-only offset mode", () => {
    const problems = paginationProblems("orders", { mode: "offset" });
    expect(problems).toContain("Endpoint 'orders': an offset parameter is required to paginate.");
    expect(problems).toContain("Endpoint 'orders': a limit parameter is required to paginate.");
    expect(problems).toContain("Endpoint 'orders': the page size must be at least 1.");
  });

  it("reports the tag-only cursor mode", () => {
    const problems = paginationProblems("orders", { mode: "cursor" });
    expect(problems).toContain("Endpoint 'orders': a cursor parameter is required to paginate.");
    expect(problems).toContain("Endpoint 'orders': a path to the next cursor is required to paginate.");
  });

  it("treats a zeroed page size as missing, because the engine does", () => {
    // The number inputs write `Number(value) || 0`, so a cleared box is 0 —
    // and the engine's `size < 1` check refuses it.
    const problems = paginationProblems("orders", { ...defaultPagination("pageSize"), size: 0 });
    expect(problems).toEqual(["Endpoint 'orders': the page size must be at least 1."]);
  });

  it("bounds the page ceiling the way MAX_REST_PAGE_LIMIT does", () => {
    expect(paginationProblems("orders", { ...defaultPagination("linkHeader"), maxPages: 0 })).toEqual([
      "Endpoint 'orders': the page ceiling must be at least 1.",
    ]);
    expect(
      paginationProblems("orders", { ...defaultPagination("linkHeader"), maxPages: 10000 }),
    ).toEqual([]);
    expect(
      paginationProblems("orders", { ...defaultPagination("linkHeader"), maxPages: 10001 }),
    ).toEqual(["Endpoint 'orders': the page ceiling cannot exceed 10000."]);
  });

  it("names an unrecognized mode instead of validating the wrong field set", () => {
    expect(paginationProblems("orders", { mode: "keyset" })).toEqual([
      "Endpoint 'orders': 'keyset' is not a pagination mode this build understands.",
    ]);
  });

  it("names the endpoint it is talking about, even before it has a name", () => {
    expect(paginationProblems("", { mode: "pageSize" })[0]).toContain("(unnamed)");
  });

  it("is reached from the Save gate, not only callable on its own", () => {
    // The gate is what actually protects the user: `restConfigProblems` had no
    // pagination check at all, so the Save button said the config was fine.
    const problems = restConfigProblems(configWith([endpoint({ pagination: { mode: "pageSize" } })]));
    expect(problems).toContain("Endpoint 'orders': a size parameter is required to paginate.");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("defaultAuth", () => {
  it("seeds a username KEY for basic auth, which the engine declares mandatory", () => {
    // `RestAuthSpec::BasicSecret { username, password_slot }` — an untouched
    // username box left NO key at all, and the save died on
    // `missing field 'username'` rather than on anything the form said.
    expect(defaultAuth("basicSecret")).toEqual({
      type: "basicSecret",
      username: "",
      passwordSlot: "",
    });
  });

  it("seeds the full field set of every other variant too", () => {
    expect(defaultAuth("bearerSecret")).toEqual({ type: "bearerSecret", slot: "" });
    expect(defaultAuth("headerSecret")).toEqual({ type: "headerSecret", header: "", slot: "" });
    expect(defaultAuth("querySecret")).toEqual({ type: "querySecret", param: "", slot: "" });
    expect(defaultAuth("none")).toEqual({ type: "none" });
  });

  it("keeps the secret-slot card pointed at the password slot", () => {
    expect(declaredSlots(defaultAuth("basicSecret"))).toEqual([]);
    expect(declaredSlots({ ...defaultAuth("basicSecret"), passwordSlot: "orders_pw" })).toEqual([
      "orders_pw",
    ]);
  });
});

describe("restConfigProblems — auth", () => {
  const withAuth = (auth: RestSourceConfigDto["auth"]): string[] =>
    restConfigProblems({ ...configWith([endpoint()]), auth });

  it("asks for the Basic username, the way it already asks for a header name", () => {
    expect(withAuth({ ...defaultAuth("basicSecret"), passwordSlot: "orders_pw" })).toEqual([
      "Name the Basic-auth username this source signs in as.",
    ]);
  });

  it("accepts a fully filled Basic spec", () => {
    expect(
      withAuth({ type: "basicSecret", username: "reporting", passwordSlot: "orders_pw" }),
    ).toEqual([]);
  });

  it("still reports a missing slot name for every variant", () => {
    expect(withAuth(defaultAuth("bearerSecret"))).toContain(
      "Name the secret slot this source's credential is stored under.",
    );
    expect(withAuth(defaultAuth("headerSecret"))).toContain(
      "Name the header the API key is sent in.",
    );
    expect(withAuth(defaultAuth("querySecret"))).toContain(
      "Name the query parameter the API key is sent in.",
    );
    // A basic spec missing BOTH halves reports both, not just the first.
    const both = withAuth(defaultAuth("basicSecret"));
    expect(both).toContain("Name the secret slot this source's credential is stored under.");
    expect(both).toContain("Name the Basic-auth username this source signs in as.");
  });
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("normalizeBody", () => {
  it("drops a cleared textarea to an ABSENT key, not an empty string", () => {
    // JSON `""` deserializes as `Some("")` under `#[serde(default)]`, and the
    // engine refuses `(Get, Some(_))` however empty the string is.
    expect(normalizeBody("")).toBeUndefined();
    expect(normalizeBody("   ")).toBeUndefined();
    expect(normalizeBody("\n\t ")).toBeUndefined();
  });

  it("keeps a real body verbatim, whitespace and all", () => {
    expect(normalizeBody(' {"filter":"all"} ')).toBe(' {"filter":"all"} ');
  });
});

describe("withMethod", () => {
  it("clears a leftover body when the method switches to GET", () => {
    const posted = endpoint({ method: "post", body: '{"filter":"all"}' });
    expect(withMethod(posted, "get")).toEqual({
      name: "orders",
      path: "v1/orders",
      method: "get",
      body: undefined,
    });
  });

  it("clears an EMPTY leftover body too — that is the one the gate let through", () => {
    // `(endpoint.body ?? "").trim() !== ""` reads `""` as no body, so the form
    // said the endpoint was fine and the engine refused it.
    const stale = endpoint({ method: "post", body: "" });
    const back = withMethod(stale, "get");
    expect(back.body).toBeUndefined();
    // And the key is gone once it crosses the IPC boundary as JSON.
    expect(Object.keys(JSON.parse(JSON.stringify(back)))).not.toContain("body");
  });

  it("leaves the body alone when switching to POST", () => {
    const get = endpoint({ method: "get" });
    expect(withMethod(get, "post")).toEqual({ name: "orders", path: "v1/orders", method: "post" });
    const kept = endpoint({ method: "post", body: '{"a":1}' });
    expect(withMethod(kept, "post").body).toBe('{"a":1}');
  });

  it("produces a GET endpoint the Save gate accepts", () => {
    const problems = restConfigProblems(
      configWith([withMethod(endpoint({ method: "post", body: "" }), "get")]),
    );
    expect(problems).toEqual([]);
  });

  it("still refuses a GET that carries a real body", () => {
    const problems = restConfigProblems(
      configWith([endpoint({ method: "get", body: '{"filter":"all"}' })]),
    );
    expect(problems).toEqual(["Endpoint 'orders': a GET request cannot carry a body."]);
  });
});
