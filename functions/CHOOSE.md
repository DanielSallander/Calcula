# CHOOSE function

## Introduction

The CHOOSE function returns a value from a list of values based on an index number. The first value in the list corresponds to index 1, the second to index 2, and so on, up to a maximum of 254 values.

Use CHOOSE when you have a numbered category and want to return a corresponding label, value, or even a range reference. It is commonly used for mapping numeric codes to descriptive text, selecting from a set of predefined options, or building dynamic formulas that switch between different calculations based on a single parameter.

## Syntax

```
=CHOOSE(index_num, value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| index_num | Required | A number between 1 and 254 that specifies which value to return. |
| value1 | Required | The first value to choose from. |
| value2, ... | Optional | Additional values, up to 254 total. |

## Remarks

- If index_num is less than 1 or greater than the number of values provided, CHOOSE returns a #VALUE! error.
- If index_num is a decimal, it is truncated to an integer (e.g., 2.7 becomes 2).
- Each value argument can be a number, text string, cell reference, range, formula, or function.

## Example

| | A | B |
|---|---|---|
| 1 | **Quarter** | **Label** |
| 2 | 1 | =CHOOSE(A2, "Q1-Jan to Mar", "Q2-Apr to Jun", "Q3-Jul to Sep", "Q4-Oct to Dec") |
| 3 | 3 | =CHOOSE(A3, "Q1-Jan to Mar", "Q2-Apr to Jun", "Q3-Jul to Sep", "Q4-Oct to Dec") |

**Result (B2):** "Q1-Jan to Mar"
**Result (B3):** "Q3-Jul to Sep"

The formula uses the quarter number in column A to select the corresponding label from the list of values.
