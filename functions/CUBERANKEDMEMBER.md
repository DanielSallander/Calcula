# CUBERANKEDMEMBER function

## Introduction

The CUBERANKEDMEMBER function returns the nth (ranked) member of a set defined by CUBESET. Combined with a sorted CUBESET, it is the standard way to build "Top N" lists — the 1st, 2nd, 3rd... member by some measure — laid out across cells.

Use CUBERANKEDMEMBER with a measure-sorted CUBESET to surface leaders and laggards: rank 1 of a descending-by-Revenue set is the top performer; rank 1 of an ascending set is the bottom.

## Syntax

```
=CUBERANKEDMEMBER(connection, set_expression, rank, [caption])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| connection | Required | The name of a Calcula BI connection (e.g. `"Sales"`). Unknown name returns `#NAME?`. |
| set_expression | Required | A reference to a CUBESET cell (or a set expression). |
| rank | Required | The 1-based position of the member to return (1 = first/top). |
| caption | Optional | A text caption to display instead of the member's default caption. |

## Remarks

- `rank` is 1-based: `1` returns the first member of the set in its current sort order.
- The returned cell behaves like a CUBEMEMBER — it **displays** a caption and **carries** the member object, so you can feed it into CUBEVALUE to read a measure for that ranked member.
- Order the source CUBESET (e.g. descending by `[Revenue]`) to make "rank 1" mean "top by Revenue".
- A `rank` beyond the size of the set returns `#N/A`.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | =CUBESET("Sales", "Geo[Country]", "Top", 2, "[Revenue]") | | |
| 2 | =CUBERANKEDMEMBER("Sales", A1, 1) | =CUBERANKEDMEMBER("Sales", A1, 2) | =CUBERANKEDMEMBER("Sales", A1, 3) |
| 3 | =CUBEVALUE("Sales", "[Revenue]", A2) | | |

**Result:** Row 2 lists the top three countries by Revenue; A3 is the #1 country's Revenue.

A1 builds a Revenue-descending set of countries; A2:C2 pull ranks 1–3; A3 reads the Revenue of the top-ranked member.
