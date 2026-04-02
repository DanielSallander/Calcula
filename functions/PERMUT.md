# PERMUT function

## Introduction
The PERMUT function returns the number of permutations for a given number of objects selected from a total. A permutation is an ordered arrangement where the order of selection matters.

## Syntax
```
=PERMUT(number, number_chosen)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The total number of objects. Must be >= 0. |
| number_chosen | Required | The number of objects in each permutation. Must be >= 0 and <= number. |

## Remarks
- Both arguments are truncated to integers.
- If number < 0 or number_chosen < 0, returns #NUM!.
- If number_chosen > number, returns #NUM!.
- PERMUT(n, k) = n! / (n - k)!.
- For permutations with repetition, use PERMUTATIONA.

## Example

| | A | B |
|---|---|---|
| 1 | **Total Objects** | **Chosen** |
| 2 | 10 | 3 |
| 3 | | |
| 4 | **Formula** | **Result** |
| 5 | =PERMUT(A2, B2) | 720 |

**Result:** 720 (there are 720 ways to arrange 3 objects selected from 10 distinct objects)
