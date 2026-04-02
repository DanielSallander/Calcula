# CHISQ.TEST function

## Introduction
The CHISQ.TEST function returns the p-value from a chi-squared test for independence. It compares an observed range of data against an expected range and determines whether the observed frequencies differ significantly from the expected frequencies.

## Syntax
```
=CHISQ.TEST(actual_range, expected_range)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| actual_range | Required | The range of observed (actual) data. |
| expected_range | Required | The range of expected values. Each expected value must be >= 5 for the test to be reliable. |

## Remarks
- actual_range and expected_range must have the same dimensions.
- If any expected value is 0, returns #DIV/0!.
- The degrees of freedom = (rows - 1) * (columns - 1) for a two-dimensional table, or (n - 1) for a single row or column.
- The function calculates the chi-squared statistic as SUM((actual - expected)^2 / expected) and returns the right-tailed probability.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Observed** | **Cat A** | **Cat B** |
| 2 | Group 1 | 50 | 30 |
| 3 | Group 2 | 40 | 45 |
| 4 | | | |
| 5 | **Expected** | **Cat A** | **Cat B** |
| 6 | Group 1 | 45 | 35 |
| 7 | Group 2 | 45 | 40 |
| 8 | | | |
| 9 | **Formula** | **Result** |
| 10 | =CHISQ.TEST(B2:C3, B6:C7) | 0.1232 |

**Result:** Approximately 0.1232 (the p-value suggests the difference between observed and expected is not statistically significant at the 5% level)
