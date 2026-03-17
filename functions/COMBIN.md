# COMBIN function

## Introduction
The COMBIN function returns the number of combinations for a given number of items. A combination is a selection of items where the order does not matter. COMBIN is used in probability calculations, lottery odds computation, and statistical sampling scenarios where you need to determine how many ways you can choose a subset from a larger set.

The formula used is: C(n, k) = n! / (k! * (n - k)!)

## Syntax
```
=COMBIN(number, number_chosen)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The total number of items (n). |
| number_chosen | Required | The number of items to choose (k). |

## Remarks
- Both arguments are truncated to integers.
- If **number** < 0, **number_chosen** < 0, or **number** < **number_chosen**, COMBIN returns a #NUM! error.
- If either argument is non-numeric, COMBIN returns a #VALUE! error.
- COMBIN(n, 0) = 1 and COMBIN(n, n) = 1.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Total Candidates** | **Positions** | **Possible Teams** |
| 2 | 10 | 3 | =COMBIN(A2, B2) |

**Result:** 120

There are 120 different ways to form a team of 3 from 10 candidates, when the order of selection does not matter.
