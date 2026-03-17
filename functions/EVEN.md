# EVEN function

## Introduction
The EVEN function rounds a number up to the nearest even integer, away from zero. Positive numbers are rounded up to the next even integer, while negative numbers are rounded away from zero (becoming more negative) to the next even integer. EVEN is useful in packaging and logistics scenarios where items must be grouped in pairs, or in engineering contexts where even-numbered dimensions are required.

## Syntax
```
=EVEN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round up to the nearest even integer. |

## Remarks
- If **number** is already an even integer, no rounding occurs.
- Positive numbers round up: EVEN(3) returns 4.
- Negative numbers round away from zero: EVEN(-3) returns -4.
- EVEN(0) returns 0.
- If **number** is non-numeric, EVEN returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Items Ordered** | **Pair-Packed Qty** |
| 2 | 7 | =EVEN(A2) |
| 3 | 12 | =EVEN(A3) |

**Results:**
- B2: 8 (rounded up from 7 to the next even number for pair packaging)
- B3: 12 (already even, no change)
