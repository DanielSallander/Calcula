# ODD function

## Introduction
The ODD function rounds a number up to the nearest odd integer, away from zero. Positive numbers are rounded to the next odd integer above, while negative numbers are rounded away from zero. ODD can be used in specialized scheduling or allocation scenarios where odd-numbered groupings are required.

## Syntax
```
=ODD(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round up to the nearest odd integer. |

## Remarks
- If **number** is already an odd integer, no rounding occurs.
- Positive numbers round up: ODD(4) returns 5.
- Negative numbers round away from zero: ODD(-4) returns -5.
- ODD(0) returns 1.
- If **number** is non-numeric, ODD returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Rounded to Odd** |
| 2 | 2.5 | =ODD(A2) |
| 3 | 5 | =ODD(A3) |
| 4 | -2.5 | =ODD(A4) |

**Results:**
- B2: 3 (rounded up from 2.5 to next odd integer)
- B3: 5 (already odd, no change)
- B4: -3 (rounded away from zero to next odd integer)
