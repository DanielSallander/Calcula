# PERMUTATIONA function

## Introduction
The PERMUTATIONA function returns the number of permutations for a given number of objects (with repetitions) that can be selected from the total objects. Unlike PERMUT, objects can be chosen more than once.

## Syntax
```
=PERMUTATIONA(number, number_chosen)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The total number of distinct objects. Must be >= 0. |
| number_chosen | Required | The number of objects in each permutation. Must be >= 0. |

## Remarks
- Both arguments are truncated to integers.
- If number < 0 or number_chosen < 0, returns #NUM!.
- PERMUTATIONA(n, k) = n^k.
- Unlike PERMUT, number_chosen can exceed number because repetition is allowed.

## Example

| | A | B |
|---|---|---|
| 1 | **Total Objects** | **Chosen** |
| 2 | 3 | 4 |
| 3 | | |
| 4 | **Formula** | **Result** |
| 5 | =PERMUTATIONA(A2, B2) | 81 |

**Result:** 81 (there are 81 ways to arrange 4 selections from 3 objects when repetition is allowed: 3^4 = 81)
