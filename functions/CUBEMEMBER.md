# CUBEMEMBER function

## Introduction

The CUBEMEMBER function returns a single member (or a tuple of members) from a Calcula BI model. The cell displays a human-readable **caption** (e.g. "Sweden"), but it also carries the underlying member object, so other CUBE functions can reference the cell instead of repeating the member expression.

Use CUBEMEMBER to define a slice once and reuse it: a CUBEMEMBER cell can be fed into CUBEVALUE (to get a measure for that member) or used as a building block for larger reports. This "displays a caption, carries an object" duality mirrors Excel's CUBEMEMBER.

## Syntax

```
=CUBEMEMBER(connection, member_expression, [caption])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| connection | Required | The name of a Calcula BI connection (e.g. `"Sales"`). Unknown name returns `#NAME?`. |
| member_expression | Required | The member or tuple to resolve. `Table[Column]=Value` for a dimension member; `m1, m2` for a tuple (AND of members); `[Measure]` for a measure member. |
| caption | Optional | A text caption to display instead of the default. If omitted, the member value (or measure name) is shown. |

## Remarks

- The cell **displays** the caption but **carries** the member object. Reference the cell from CUBEVALUE (e.g. `=CUBEVALUE("Sales","[Revenue]", A1)`) to slice a measure by that member without re-typing the expression.
- A tuple (`"T1[C1]=v1, T2[C2]=v2"`) is treated as multiple AND-ed member filters.
- In v1, the **existence** of the member value is not verified against the model — a caption is produced from the expression as written.
- Reference CUBEMEMBER cells (which are stable) rather than other formula cells recomputed in the same edit, so the async pre-fetch and the synchronous evaluator agree on the lookup.
- A malformed member expression returns `#VALUE!`; a disconnected model returns `#N/A`.

## Example

| | A | B |
|---|---|---|
| 1 | =CUBEMEMBER("Sales", "Geo[Country]=Sweden") | =CUBEVALUE("Sales", "[Revenue]", A1) |
| 2 | =CUBEMEMBER("Sales", "Geo[Country]=Sweden", "🇸🇪 Sweden") | |

**Result:** A1 displays "Sweden"; A2 displays "🇸🇪 Sweden"; B1 returns Sweden's Revenue.

A1 resolves the country member and shows its default caption; B1 slices Revenue by the member carried in A1. A2 shows a custom caption while carrying the same member.
