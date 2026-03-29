# FORMULATEXT function

## Introduction
The FORMULATEXT function returns the formula in a given cell as a text string. It is useful for documentation, auditing, and displaying formulas alongside their results without manually typing them out.

## Syntax
```
=FORMULATEXT(reference)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| reference | Required | A reference to the cell containing the formula to display. |

## Remarks
- Returns the formula as text including the leading equals sign.
- Returns #N/A if the referenced cell does not contain a formula.
- Works across sheets when using a sheet-qualified reference.
- The returned text reflects the formula as entered, not the calculated result.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Formula** |
| 2 | =SUM(1, 2, 3) | =FORMULATEXT(A2) |

**Result:** B2 = "=SUM(1, 2, 3)", A2 = 6
