# CUBESETCOUNT function

## Introduction

The CUBESETCOUNT function returns the number of items in a set defined by CUBESET. It lets a report adapt to how many members a set actually contains — for instance, to size a ranked list or to drive a loop of CUBERANKEDMEMBER calls.

## Syntax

```
=CUBESETCOUNT(set)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| set | Required | A reference to a cell containing a CUBESET (or a CUBESET expression). |

## Remarks

- The argument is normally a cell reference to a CUBESET cell. The count is read from the set's carried member list — no additional model query is required when the set is already resolved.
- If the referenced cell is not a set (e.g. it is empty or holds a plain value), the result is an error.
- A disconnected model or unresolved set returns `#N/A`.

## Example

| | A | B |
|---|---|---|
| 1 | =CUBESET("Sales", "Geo[Country]", "Countries") | =CUBESETCOUNT(A1) |

**Result:** B1 is the number of distinct countries in the `Sales` model.

A1 defines the set of all countries; B1 returns how many there are, so the rest of the report can size itself accordingly.
