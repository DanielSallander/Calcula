// FILENAME: app/extensions/ModelEditor/components/sections/RestSourceForm.tsx
// PURPOSE:  The editor for a Web/REST data source, plus its secret-slot card.
//
// A REST source is described ENTIRELY BY DATA — a base URL, some endpoints,
// a pagination mode — so it saves into the model file and reconnects on reopen
// like any other source. This form is therefore a plain structured editor, not
// a code surface.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE VISIBLY: the config carries secret
// SLOT NAMES, never secret values. Everything typed into the auth picker is a
// name; the values live in Windows Credential Manager and are written through
// a separate, write-only command. `defaultHeaders` and an endpoint's query
// params DO persist into the model file, which is why they carry a warning —
// a token pasted there is written into every copy of the workbook.
//
// The validation here deliberately mirrors the engine's own
// `RestSourceConfig::validate()` (which is I/O-free, so it can run on every
// keystroke server-side too). Where the two could drift, the engine wins: the
// backend re-validates on save and its message is what the user finally sees.

import React, { useCallback, useEffect, useState } from "react";
import {
  biModelSourceSecretsDelete,
  biModelSourceSecretsList,
  biModelSourceSecretsSet,
} from "@api";
import type {
  RestAuthSpecDto,
  RestEndpointDto,
  RestFieldDto,
  RestPaginationDto,
  RestSourceConfigDto,
  SourceSecretSlot,
} from "@api";
import { Badge, Field, styles } from "../editorShared";

/** The auth shapes the engine understands. Each collects slot NAMES only. */
const REST_AUTHS = [
  { value: "none", label: "None (public API)" },
  { value: "bearerSecret", label: "Bearer token" },
  { value: "headerSecret", label: "API key in a header" },
  { value: "querySecret", label: "API key in a query parameter" },
  { value: "basicSecret", label: "Basic (username + password)" },
];

const REST_METHODS = [
  { value: "get", label: "GET" },
  { value: "post", label: "POST" },
];

/** Only these four are inferred from a sample; the rest must be declared. */
const REST_DATA_TYPES = [
  { value: "String", label: "Text" },
  { value: "Int64", label: "Whole number" },
  { value: "Float64", label: "Decimal number" },
  { value: "Boolean", label: "True/false" },
  { value: "Date", label: "Date (declare — never inferred)" },
  { value: "Timestamp", label: "Timestamp (declare — never inferred)" },
];

const PAGINATION_MODES = [
  { value: "none", label: "Single request" },
  { value: "pageSize", label: "Page number + size" },
  { value: "offset", label: "Offset + limit" },
  { value: "cursor", label: "Cursor from the response" },
  { value: "linkHeader", label: "Link header (rel=\"next\")" },
];

const DEFAULT_TIMEOUT_SECS = 30;
const MAX_TIMEOUT_SECS = 600;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;

/** Rows requested per page, seeded into a freshly chosen paginating mode. */
const DEFAULT_PAGE_SIZE = 100;
/** The page ceiling seeded into a freshly chosen paginating mode. */
const DEFAULT_MAX_PAGES = 50;
/** `MAX_REST_PAGE_LIMIT` in the engine — the largest ceiling it accepts. */
const MAX_PAGES_LIMIT = 10000;

/**
 * The full field set a pagination mode requires, with real defaults.
 *
 * The engine's `RestPagination` is an internally tagged enum whose paginating
 * variants declare their operands as PLAIN (non-`Option`, no `serde(default)`)
 * fields, so a DTO that carries only `{ "mode": "pageSize" }` does not
 * deserialize at all — the save fails with a raw `missing field 'size'`. The
 * mode picker therefore seeds the whole variant rather than letting the inputs
 * show defaults they never wrote down.
 */
export function defaultPagination(mode: string): RestPaginationDto {
  switch (mode) {
    case "pageSize":
      return {
        mode,
        pageParam: "page",
        sizeParam: "per_page",
        size: DEFAULT_PAGE_SIZE,
        maxPages: DEFAULT_MAX_PAGES,
      };
    case "offset":
      return {
        mode,
        offsetParam: "offset",
        limitParam: "limit",
        limit: DEFAULT_PAGE_SIZE,
        maxPages: DEFAULT_MAX_PAGES,
      };
    case "cursor":
      // The cursor PATH cannot be guessed — it is response-shaped — so it is
      // seeded empty and reported as a problem until the author names it.
      return { mode, cursorParam: "cursor", cursorPath: "", maxPages: DEFAULT_MAX_PAGES };
    case "linkHeader":
      return { mode, maxPages: DEFAULT_MAX_PAGES };
    default:
      // "none" is a unit variant: carrying another mode's leftovers would be
      // dead weight in the model file, so the rest is cleared.
      return { mode: "none" };
  }
}

/**
 * The full field set an auth type requires, with empty (but PRESENT) names.
 *
 * Same reason as `defaultPagination`: `RestAuthSpec`'s variants declare plain
 * `String` fields. `{ "type": "basicSecret" }` with an untouched username box
 * is `missing field 'username'` at the serde boundary, not a form error.
 */
export function defaultAuth(type: string): RestAuthSpecDto {
  switch (type) {
    case "bearerSecret":
      return { type, slot: "" };
    case "headerSecret":
      return { type, header: "", slot: "" };
    case "querySecret":
      return { type, param: "", slot: "" };
    case "basicSecret":
      return { type, username: "", passwordSlot: "" };
    default:
      return { type: "none" };
  }
}

/** A config for a source that has not been configured yet. */
export function emptyRestConfig(): RestSourceConfigDto {
  return {
    baseUrl: "https://",
    defaultHeaders: [],
    auth: { type: "none" },
    endpoints: [],
    timeoutSecs: DEFAULT_TIMEOUT_SECS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  };
}

/**
 * A request body normalized to what the engine will accept.
 *
 * `body: Option<String>` carries `#[serde(default)]`, so JSON `""` arrives as
 * `Some("")` — and the engine refuses `(Get, Some(_))` outright. A textarea the
 * author cleared must therefore drop the KEY, not leave an empty string behind.
 */
export function normalizeBody(raw: string): string | undefined {
  return raw.trim() === "" ? undefined : raw;
}

/**
 * The endpoint with its HTTP method switched.
 *
 * Switching to GET DROPS the body rather than merely hiding its box: the
 * engine's `validate_endpoint` refuses `(Get, Some(_))` whatever the body says,
 * so a body left over from a POST — including an empty string, which
 * deserializes as `Some("")` — makes the source unsaveable with no visible
 * cause, because the textarea is no longer on screen.
 */
export function withMethod(endpoint: RestEndpointDto, method: string): RestEndpointDto {
  if (method === "get") return { ...endpoint, method, body: undefined };
  return { ...endpoint, method };
}

/** `true` for a host the engine lets use plain `http://` (local development). */
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\./.test(bare);
}

/**
 * Why a base URL would be refused, or null when it is fine.
 *
 * Mirrors the engine's rule: https only, except a loopback host; and never
 * credentials in the URL, since those would be written into the model file.
 */
export function baseUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value === "https://") return "A base URL is required.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "That is not a valid URL.";
  }
  if (url.username !== "" || url.password !== "") {
    return "Credentials in the URL are not allowed — use a secret slot instead.";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname)
      ? null
      : "Plain http:// is only allowed for localhost — use https://.";
  }
  return "Only https:// (or http:// on localhost) is supported.";
}

/** Why an endpoint path would be refused, or null. */
export function endpointPathProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "A path is required.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//")) {
    return "A path cannot carry its own scheme or host — it is joined to the base URL.";
  }
  if (value.split("/").some((segment) => segment === "..")) {
    return "A path cannot contain a '..' segment.";
  }
  return null;
}

/** The slot names an auth spec declares, in the order the form shows them. */
export function declaredSlots(auth: RestAuthSpecDto | undefined): string[] {
  if (!auth) return [];
  switch (auth.type) {
    case "bearerSecret":
    case "headerSecret":
    case "querySecret":
      return auth.slot ? [auth.slot] : [];
    case "basicSecret":
      return auth.passwordSlot ? [auth.passwordSlot] : [];
    default:
      return [];
  }
}

/**
 * Why an endpoint's pagination would be refused, or an empty list.
 *
 * Mirrors the engine's `validate_pagination`: every paginating mode needs its
 * parameter names, a page size of at least 1 where it takes one, and a ceiling
 * between 1 and `MAX_REST_PAGE_LIMIT`. Without this the Save gate passed a
 * half-built mode straight into `serde_json::from_value`, and the author met a
 * raw `missing field 'size'` instead of a sentence.
 */
export function paginationProblems(
  endpointName: string,
  pagination: RestPaginationDto | undefined,
): string[] {
  const mode = pagination?.mode ?? "none";
  if (!pagination || mode === "none") return [];
  const where = `Endpoint '${endpointName || "(unnamed)"}'`;
  const problems: string[] = [];
  const requireName = (value: string | undefined, what: string) => {
    if ((value ?? "").trim() === "") problems.push(`${where}: ${what} is required to paginate.`);
  };
  const requireCount = (value: number | undefined, what: string) => {
    if (value === undefined || !Number.isFinite(value) || value < 1) {
      problems.push(`${where}: ${what} must be at least 1.`);
    }
  };

  switch (mode) {
    case "pageSize":
      requireName(pagination.pageParam, "a page parameter");
      requireName(pagination.sizeParam, "a size parameter");
      requireCount(pagination.size, "the page size");
      break;
    case "offset":
      requireName(pagination.offsetParam, "an offset parameter");
      requireName(pagination.limitParam, "a limit parameter");
      requireCount(pagination.limit, "the page size");
      break;
    case "cursor":
      requireName(pagination.cursorParam, "a cursor parameter");
      requireName(pagination.cursorPath, "a path to the next cursor");
      break;
    case "linkHeader":
      break;
    default:
      // A mode this build does not know: report it rather than validating the
      // wrong field set and calling it fine.
      return [`${where}: '${mode}' is not a pagination mode this build understands.`];
  }

  const maxPages = pagination.maxPages;
  if (maxPages === undefined || !Number.isFinite(maxPages) || maxPages < 1) {
    problems.push(`${where}: the page ceiling must be at least 1.`);
  } else if (maxPages > MAX_PAGES_LIMIT) {
    problems.push(`${where}: the page ceiling cannot exceed ${MAX_PAGES_LIMIT}.`);
  }
  return problems;
}

/** Every reason this config would be refused, most important first. */
export function restConfigProblems(config: RestSourceConfigDto): string[] {
  const problems: string[] = [];
  const base = baseUrlProblem(config.baseUrl);
  if (base) problems.push(base);

  if (config.endpoints.length === 0) {
    problems.push("Add at least one endpoint — each one becomes a table you can import.");
  }
  const names = new Set<string>();
  for (const endpoint of config.endpoints) {
    const name = endpoint.name.trim();
    if (name === "") {
      problems.push("Every endpoint needs a name.");
    } else if (names.has(name)) {
      problems.push(`Two endpoints are both named '${name}'.`);
    } else {
      names.add(name);
    }
    const path = endpointPathProblem(endpoint.path);
    if (path) problems.push(`Endpoint '${name || "(unnamed)"}': ${path}`);
    if ((endpoint.method ?? "get") === "get" && (endpoint.body ?? "").trim() !== "") {
      problems.push(`Endpoint '${name}': a GET request cannot carry a body.`);
    }
    problems.push(...paginationProblems(name, endpoint.pagination));
  }

  const auth = config.auth;
  if (auth && auth.type !== "none" && declaredSlots(auth).length === 0) {
    problems.push("Name the secret slot this source's credential is stored under.");
  }
  if (auth?.type === "headerSecret" && !(auth.header ?? "").trim()) {
    problems.push("Name the header the API key is sent in.");
  }
  if (auth?.type === "querySecret" && !(auth.param ?? "").trim()) {
    problems.push("Name the query parameter the API key is sent in.");
  }
  if (auth?.type === "basicSecret" && !(auth.username ?? "").trim()) {
    // Stricter than the engine, which only rejects control characters here —
    // deliberately. HTTP Basic with no username is a half-filled form, and an
    // ABSENT username is `missing field 'username'` at the serde boundary.
    problems.push("Name the Basic-auth username this source signs in as.");
  }

  const timeout = config.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;
  if (timeout < 1 || timeout > MAX_TIMEOUT_SECS) {
    problems.push(`The timeout must be between 1 and ${MAX_TIMEOUT_SECS} seconds.`);
  }
  const cap = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (cap < 1024 || cap > MAX_RESPONSE_BYTES) {
    problems.push("The response limit must be between 1 KB and 512 MB.");
  }
  return problems;
}

const rowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-end" };
const cardStyle: React.CSSProperties = {
  border: "1px solid #e1dfdd",
  borderRadius: 4,
  padding: 10,
  marginBottom: 8,
};

/** A small "remove this row" button, used throughout the repeated lists. */
function RemoveButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button style={{ ...styles.btn, padding: "4px 8px" }} title={title} onClick={onClick}>
      Remove
    </button>
  );
}

/** The editor for one endpoint — which becomes one importable table. */
function EndpointCard({
  endpoint,
  onChange,
  onRemove,
}: {
  endpoint: RestEndpointDto;
  onChange: (next: RestEndpointDto) => void;
  onRemove: () => void;
}): React.ReactElement {
  const set = <K extends keyof RestEndpointDto>(key: K, value: RestEndpointDto[K]) =>
    onChange({ ...endpoint, [key]: value });

  const method = endpoint.method ?? "get";
  const fields = endpoint.fields ?? [];
  const pagination = endpoint.pagination ?? { mode: "none" };
  const pathProblem = endpointPathProblem(endpoint.path);

  const setField = (index: number, next: RestFieldDto) =>
    set(
      "fields",
      fields.map((f, i) => (i === index ? next : f)),
    );

  return (
    <div style={cardStyle}>
      <div style={rowStyle}>
        <Field label="Table name" flex={1}>
          <input
            style={styles.input}
            value={endpoint.name}
            placeholder="orders"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label="Path" flex={2}>
          <input
            style={styles.input}
            value={endpoint.path}
            placeholder="v1/orders"
            onChange={(e) => set("path", e.target.value)}
          />
        </Field>
        <Field label="Method" flex={1}>
          <select
            style={styles.input}
            value={method}
            onChange={(e) => onChange(withMethod(endpoint, e.target.value))}
          >
            {REST_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <RemoveButton onClick={onRemove} title="Remove this endpoint" />
      </div>
      {pathProblem && (
        <div style={{ fontSize: 12, color: "#a4262c", marginBottom: 6 }}>{pathProblem}</div>
      )}

      <Field label="Path to the rows in the response">
        <input
          style={styles.input}
          value={endpoint.rowsPath ?? ""}
          placeholder="data.items — leave empty if the response IS the array"
          onChange={(e) => set("rowsPath", e.target.value)}
        />
      </Field>

      {method === "post" && (
        <Field label="Request body (JSON)">
          <textarea
            style={{ ...styles.input, minHeight: 60, fontFamily: "Consolas, monospace" }}
            value={endpoint.body ?? ""}
            placeholder='{"filter":"all"}'
            onChange={(e) => set("body", normalizeBody(e.target.value))}
          />
        </Field>
      )}

      {/* --- Pagination --- */}
      <Field label="Pagination">
        <select
          style={styles.input}
          value={pagination.mode}
          // Seed the WHOLE variant. Every paginating mode's operands are
          // mandatory in the engine's enum, so a mode change that wrote only
          // the tag produced a config that could not be deserialized at all.
          onChange={(e) => set("pagination", defaultPagination(e.target.value))}
        >
          {PAGINATION_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      {pagination.mode !== "none" && (
        <div style={rowStyle}>
          {pagination.mode === "pageSize" && (
            <>
              <Field label="Page parameter" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.pageParam ?? ""}
                  placeholder="page"
                  onChange={(e) => set("pagination", { ...pagination, pageParam: e.target.value })}
                />
              </Field>
              <Field label="Size parameter" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.sizeParam ?? ""}
                  placeholder="per_page"
                  onChange={(e) => set("pagination", { ...pagination, sizeParam: e.target.value })}
                />
              </Field>
              <Field label="Page size" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.size ?? ""}
                  onChange={(e) =>
                    set("pagination", { ...pagination, size: Number(e.target.value) || 0 })
                  }
                />
              </Field>
            </>
          )}
          {pagination.mode === "offset" && (
            <>
              <Field label="Offset parameter" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.offsetParam ?? ""}
                  placeholder="offset"
                  onChange={(e) => set("pagination", { ...pagination, offsetParam: e.target.value })}
                />
              </Field>
              <Field label="Limit parameter" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.limitParam ?? ""}
                  placeholder="limit"
                  onChange={(e) => set("pagination", { ...pagination, limitParam: e.target.value })}
                />
              </Field>
              <Field label="Page size" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.limit ?? ""}
                  onChange={(e) =>
                    set("pagination", { ...pagination, limit: Number(e.target.value) || 0 })
                  }
                />
              </Field>
            </>
          )}
          {pagination.mode === "cursor" && (
            <>
              <Field label="Cursor parameter" flex={1}>
                <input
                  style={styles.input}
                  value={pagination.cursorParam ?? ""}
                  placeholder="after"
                  onChange={(e) => set("pagination", { ...pagination, cursorParam: e.target.value })}
                />
              </Field>
              <Field label="Path to the next cursor" flex={2}>
                <input
                  style={styles.input}
                  value={pagination.cursorPath ?? ""}
                  placeholder="meta.next_cursor"
                  onChange={(e) => set("pagination", { ...pagination, cursorPath: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="Max pages" flex={1}>
            <input
              style={styles.input}
              value={pagination.maxPages ?? ""}
              onChange={(e) =>
                set("pagination", { ...pagination, maxPages: Number(e.target.value) || 0 })
              }
            />
          </Field>
        </div>
      )}

      {/* --- Columns --- */}
      <div style={{ ...styles.hint, marginTop: 8, marginBottom: 4 }}>
        {fields.length === 0
          ? "Columns will be inferred from the first page — which only ever produces text, whole numbers, decimals and true/false. Declare a column below to get a Date or Timestamp, or to read a value nested inside an object."
          : "Declared columns. A path may reach into the row object, e.g. customer.name."}
      </div>
      {fields.map((field, index) => (
        <div key={index} style={rowStyle}>
          <Field label="Path in the row" flex={2}>
            <input
              style={styles.input}
              value={field.path}
              placeholder="customer.name"
              onChange={(e) => setField(index, { ...field, path: e.target.value })}
            />
          </Field>
          <Field label="Column name" flex={2}>
            <input
              style={styles.input}
              value={field.name}
              onChange={(e) => setField(index, { ...field, name: e.target.value })}
            />
          </Field>
          <Field label="Type" flex={2}>
            <select
              style={styles.input}
              value={field.dataType}
              onChange={(e) => setField(index, { ...field, dataType: e.target.value })}
            >
              {REST_DATA_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <RemoveButton
            onClick={() =>
              set(
                "fields",
                fields.filter((_, i) => i !== index),
              )
            }
            title="Remove this column"
          />
        </div>
      ))}
      <button
        style={styles.btn}
        onClick={() => set("fields", [...fields, { path: "", name: "", dataType: "String" }])}
      >
        Add column
      </button>
    </div>
  );
}

/** The whole REST configuration editor. */
export function RestSourceForm({
  config,
  onChange,
}: {
  config: RestSourceConfigDto;
  onChange: (next: RestSourceConfigDto) => void;
}): React.ReactElement {
  const set = <K extends keyof RestSourceConfigDto>(key: K, value: RestSourceConfigDto[K]) =>
    onChange({ ...config, [key]: value });

  const auth = config.auth ?? { type: "none" };
  const headers = config.defaultHeaders ?? [];
  const urlProblem = baseUrlProblem(config.baseUrl);

  return (
    <>
      <Field label="Base URL">
        <input
          style={styles.input}
          value={config.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(e) => set("baseUrl", e.target.value)}
        />
      </Field>
      {urlProblem && (
        <div style={{ fontSize: 12, color: "#a4262c", marginBottom: 6 }}>{urlProblem}</div>
      )}

      {/* --- Auth: SLOT NAMES ONLY --- */}
      <Field label="Authentication">
        <select
          style={styles.input}
          value={auth.type}
          // Seed the WHOLE variant, for the same reason the pagination picker
          // does: `basicSecret` without a `username` KEY is a serde failure,
          // not a form error, and the username box only writes onChange.
          onChange={(e) => set("auth", defaultAuth(e.target.value))}
        >
          {REST_AUTHS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      {auth.type !== "none" && (
        <>
          <div style={rowStyle}>
            {auth.type === "headerSecret" && (
              <Field label="Header name" flex={1}>
                <input
                  style={styles.input}
                  value={auth.header ?? ""}
                  placeholder="X-Api-Key"
                  onChange={(e) => set("auth", { ...auth, header: e.target.value })}
                />
              </Field>
            )}
            {auth.type === "querySecret" && (
              <Field label="Query parameter" flex={1}>
                <input
                  style={styles.input}
                  value={auth.param ?? ""}
                  placeholder="api_key"
                  onChange={(e) => set("auth", { ...auth, param: e.target.value })}
                />
              </Field>
            )}
            {auth.type === "basicSecret" && (
              <Field label="Username" flex={1}>
                <input
                  style={styles.input}
                  value={auth.username ?? ""}
                  onChange={(e) => set("auth", { ...auth, username: e.target.value })}
                />
              </Field>
            )}
            <Field label="Secret slot name" flex={1}>
              <input
                style={styles.input}
                value={(auth.type === "basicSecret" ? auth.passwordSlot : auth.slot) ?? ""}
                placeholder="e.g. orders_token"
                onChange={(e) =>
                  set(
                    "auth",
                    auth.type === "basicSecret"
                      ? { ...auth, passwordSlot: e.target.value }
                      : { ...auth, slot: e.target.value },
                  )
                }
              />
            </Field>
          </div>
          <div style={styles.hint}>
            This is the slot&apos;s <strong>name</strong>, not the credential. Save the source, then
            store the value in the Secrets card — it goes into Windows Credential Manager and is
            never written into the model file.
          </div>
        </>
      )}

      {/* --- Default headers (PERSISTED) --- */}
      <div style={{ ...styles.hint, marginTop: 10, marginBottom: 4 }}>
        Default headers are sent with every request and <strong>are saved into the workbook</strong>
        , so they are for request shaping only (Accept, an API version). A token belongs in a secret
        slot above.
      </div>
      {headers.map((header, index) => (
        <div key={index} style={rowStyle}>
          <Field label="Header" flex={1}>
            <input
              style={styles.input}
              value={header.name}
              placeholder="Accept"
              onChange={(e) =>
                set(
                  "defaultHeaders",
                  headers.map((h, i) => (i === index ? { ...h, name: e.target.value } : h)),
                )
              }
            />
          </Field>
          <Field label="Value" flex={2}>
            <input
              style={styles.input}
              value={header.value}
              placeholder="application/json"
              onChange={(e) =>
                set(
                  "defaultHeaders",
                  headers.map((h, i) => (i === index ? { ...h, value: e.target.value } : h)),
                )
              }
            />
          </Field>
          <RemoveButton
            onClick={() =>
              set(
                "defaultHeaders",
                headers.filter((_, i) => i !== index),
              )
            }
            title="Remove this header"
          />
        </div>
      ))}
      <button
        style={styles.btn}
        onClick={() => set("defaultHeaders", [...headers, { name: "", value: "" }])}
      >
        Add header
      </button>

      {/* --- Endpoints --- */}
      <div style={{ fontWeight: 600, marginTop: 14, marginBottom: 6 }}>
        Endpoints{" "}
        <span style={styles.muted}>— each becomes a table you can import</span>
      </div>
      {config.endpoints.map((endpoint, index) => (
        <EndpointCard
          key={index}
          endpoint={endpoint}
          onChange={(next) =>
            set(
              "endpoints",
              config.endpoints.map((e, i) => (i === index ? next : e)),
            )
          }
          onRemove={() =>
            set(
              "endpoints",
              config.endpoints.filter((_, i) => i !== index),
            )
          }
        />
      ))}
      <button
        style={styles.btn}
        onClick={() =>
          set("endpoints", [
            ...config.endpoints,
            { name: "", path: "", method: "get", rowsPath: "", fields: [], pagination: { mode: "none" } },
          ])
        }
      >
        Add endpoint
      </button>

      {/* --- Guard rails --- */}
      <div style={{ ...styles.hint, marginTop: 14, marginBottom: 4 }}>
        Limits. Reaching the page cap stops paging; exceeding the response limit is refused outright,
        because returning half a table silently would be a wrong answer.
      </div>
      <div style={rowStyle}>
        <Field label="Timeout (seconds)" flex={1}>
          <input
            style={styles.input}
            value={config.timeoutSecs ?? DEFAULT_TIMEOUT_SECS}
            onChange={(e) => set("timeoutSecs", Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="Response limit (MB)" flex={1}>
          <input
            style={styles.input}
            value={Math.round((config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) / (1024 * 1024))}
            onChange={(e) =>
              set("maxResponseBytes", (Number(e.target.value) || 0) * 1024 * 1024)
            }
          />
        </Field>
      </div>
    </>
  );
}

/**
 * The secret-slot card for a saved REST source.
 *
 * Values are write-only by construction: `list` reports only whether a slot is
 * set, and no command returns a value. That is why there is no "show" affordance
 * here — there is nothing to show.
 */
export function RestSecretsCard({
  connectionId,
  source,
  readOnly,
  reportError,
}: {
  connectionId: string;
  source: { id: string; rest: RestSourceConfigDto | null };
  readOnly: boolean;
  reportError: (message: string) => void;
}): React.ReactElement | null {
  const [slots, setSlots] = useState<SourceSecretSlot[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const declared = declaredSlots(source.rest?.auth);

  const load = useCallback(() => {
    if (declared.length === 0) {
      setSlots([]);
      return;
    }
    void biModelSourceSecretsList(connectionId, source.id).then(setSlots, (e: unknown) =>
      reportError(String(e)),
    );
    // `declared` is derived from the source prop; depending on its joined form
    // keeps this from re-firing on every render while still reacting to a
    // changed slot list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, source.id, declared.join(","), reportError]);

  useEffect(load, [load]);

  if (declared.length === 0) return null;

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().then(
      () => {
        setBusy(false);
        load();
      },
      (e: unknown) => {
        setBusy(false);
        reportError(String(e));
      },
    );
  };

  return (
    <div style={{ ...cardStyle, marginTop: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Secrets</div>
      <div style={{ ...styles.hint, marginBottom: 8 }}>
        Stored in Windows Credential Manager on this machine, never in the workbook. A stored value
        cannot be read back — only replaced or forgotten.
      </div>
      {declared.map((slot) => {
        const isSet = slots.find((s) => s.slot === slot)?.isSet ?? false;
        const draft = drafts[slot] ?? "";
        return (
          <div key={slot} style={{ ...rowStyle, marginBottom: 6 }}>
            <Field label={slot} flex={2}>
              <input
                style={styles.input}
                type="password"
                value={draft}
                placeholder={isSet ? "•••••••• (stored)" : "not set"}
                disabled={readOnly || busy}
                onChange={(e) => setDrafts((p) => ({ ...p, [slot]: e.target.value }))}
              />
            </Field>
            <Badge tone={isSet ? "ok" : "warn"}>{isSet ? "set" : "not set"}</Badge>
            <button
              style={styles.btn}
              disabled={readOnly || busy || draft === ""}
              title={draft === "" ? "Type a value to store it" : "Store this value"}
              onClick={() =>
                run(async () => {
                  await biModelSourceSecretsSet(connectionId, source.id, slot, draft);
                  setDrafts((p) => ({ ...p, [slot]: "" }));
                })
              }
            >
              Store
            </button>
            <button
              style={styles.btn}
              disabled={readOnly || busy || !isSet}
              onClick={() =>
                run(() => biModelSourceSecretsDelete(connectionId, source.id, slot))
              }
            >
              Forget
            </button>
          </div>
        );
      })}
    </div>
  );
}
