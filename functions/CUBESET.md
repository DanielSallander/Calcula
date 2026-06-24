# CUBESET function

## Introduction

The CUBESET function defines a calculated **set** of members from a Calcula BI model — for example, "all countries" or "all product categories" — optionally sorted by a measure. The cell displays a caption, but it carries the ordered member list, which CUBESETCOUNT and CUBERANKEDMEMBER then operate on.

Use CUBESET to build a ranked or filtered list you can drive a small report from: define the set once, count it with CUBESETCOUNT, and pull individual ranked members out with CUBERANKEDMEMBER (e.g. top 5 countries by revenue).

## Syntax

```
=CUBESET(connection, set_expression, [caption], [sort_order], [sort_by])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| connection | Required | The name of a Calcula BI connection (e.g. `"Sales"`). Unknown name returns `#NAME?`. |
| set_expression | Required | The set to resolve: `Table[Column]` for all members of a level, or `{m1, m2, ...}` for an explicit list. |
| caption | Optional | A text caption to display for the set. |
| sort_order | Optional | `0` none, `1` ascending by measure, `2` descending by measure, `3` alphabetical ascending, `4` alphabetical descending. Defaults to `0`. |
| sort_by | Optional | The measure expression (e.g. `"[Revenue]"`) used when `sort_order` is `1` or `2`. |

## Remarks

- A level set (`Table[Column]`) expands to the distinct members of that column; an explicit set (`{...}`) uses the listed members as-is.
- Measure ordering (`sort_order` 1 or 2) applies to **level** sets. Explicit `{...}` lists support **alphabetical** ordering (`sort_order` 3 or 4) but not measure ordering.
- When `sort_order` is 1 or 2, give `sort_by` a measure; if it is omitted, the model's default measure is used.
- The set cell **displays** the caption but **carries** the ordered member list — feed the cell into CUBESETCOUNT and CUBERANKEDMEMBER.
- A disconnected model returns `#N/A`; a malformed set expression returns `#VALUE!`.

## Example

| | A | B |
|---|---|---|
| 1 | =CUBESET("Sales", "Geo[Country]", "Countries by Revenue", 2, "[Revenue]") | =CUBESETCOUNT(A1) |
| 2 | =CUBERANKEDMEMBER("Sales", A1, 1) | =CUBEVALUE("Sales", "[Revenue]", A2) |

**Result:** A1 shows "Countries by Revenue"; B1 is the number of countries; A2 is the #1 country by Revenue; B2 is that country's Revenue.

A1 builds the set of countries ordered by Revenue (descending). B1 counts them, A2 pulls the top-ranked country, and B2 reads that country's Revenue.
