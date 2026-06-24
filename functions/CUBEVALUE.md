# CUBEVALUE function

## Introduction

The CUBEVALUE function returns an aggregated value (a measure) from a Calcula BI model, sliced by zero or more member expressions. It is the workhorse of the CUBE formula family: where a PivotTable shows a whole grid of aggregated numbers, CUBEVALUE pulls a single number into one cell, so you can build free-form report layouts driven by live model data.

Use CUBEVALUE when you want a specific measure value for a specific slice of the model — for example, total revenue for Sweden, or units sold for a product category in a given year. Unlike Excel, where CUBE formulas speak MDX to an OLAP cube, Calcula's CUBE functions query a **Calcula BI model** exposed as a named connection.

## Syntax

```
=CUBEVALUE(connection, [member_expression1], [member_expression2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| connection | Required | The name of a Calcula BI connection (a `Connection.name`, e.g. `"Sales"`). Resolved by name; an unknown name returns `#NAME?`. |
| member_expression | Optional | A measure, dimension member, or tuple that constrains the value. May be a string literal or a reference to a cell containing a CUBEMEMBER/CUBESET. If no measure is given, the model's first measure is used. |

## Member-expression syntax (Calcula-native)

| Form | Meaning |
|------|---------|
| `[Measure Name]` | A model measure (what to aggregate). |
| `Table[Column]=Value` | A dimension member filter (the value may be `'single-quoted'`). |
| `Table[Column]` | A level — all members of a column (rarely used directly in CUBEVALUE). |
| `m1, m2` within one argument | A tuple — multiple members AND-ed together. |

## Remarks

- The first argument is always the connection name. Remaining arguments slice the value.
- If you supply no `[Measure]`, the model's first measure is used as a default.
- A member argument may be a direct cell reference to a CUBEMEMBER cell, so you can build a slice once and reuse it (e.g. `B2 =CUBEMEMBER("Sales","Geo[Country]=Sweden")`, then `=CUBEVALUE("Sales","[Revenue]",B2)`).
- Member filters are matched by **column name only** (the engine's filter carries no table), so keep member column names unique across tables.
- Cube formulas resolve through an asynchronous pre-fetch before each recalc. A disconnected model, or a slice with no matching data, returns `#N/A`; a malformed member expression returns `#VALUE!`.

## Example

| | A | B |
|---|---|---|
| 1 | **Revenue (Sweden)** | =CUBEVALUE("Sales", "[Revenue]", "Geo[Country]=Sweden") |
| 2 | **Member cell** | =CUBEMEMBER("Sales", "Geo[Country]=Sweden") |
| 3 | **Revenue (via B2)** | =CUBEVALUE("Sales", "[Revenue]", B2) |

**Result (B1 and B3):** the same Revenue figure for Sweden.

B1 filters Revenue directly by a literal member; B3 reuses the member object defined in B2 — both return Sweden's Revenue from the `Sales` model.
