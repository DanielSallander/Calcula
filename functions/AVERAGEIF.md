# AVERAGEIF function

## Introduction
The AVERAGEIF function calculates the arithmetic mean of cells in a range that meet a single condition. It combines the filtering capability of SUMIF with the averaging logic of AVERAGE, making it useful for targeted analysis such as finding the average salary in a specific department or the mean order value above a certain threshold.

## Syntax
```
=AVERAGEIF(range, criteria, [average_range])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| range | Required | The range of cells to evaluate against the criteria. |
| criteria | Required | The condition that determines which cells to average. Can be a number, expression, text string, or cell reference. |
| average_range | Optional | The actual cells to average. If omitted, **range** is used. |

### Criteria examples
- `">50000"` -- values greater than 50,000.
- `"Marketing"` -- cells matching the text "Marketing".
- `"<>0"` -- non-zero values.

## Remarks
- If no cells in the range meet the criteria, AVERAGEIF returns a #DIV/0! error.
- Criteria are case-insensitive for text comparisons.
- Wildcard characters (* and ?) are supported in text criteria.
- Cells in average_range that are empty or contain text are ignored.

## Example

| | A | B |
|---|---|---|
| 1 | **Department** | **Salary** |
| 2 | Engineering | 95000 |
| 3 | Marketing | 72000 |
| 4 | Engineering | 88000 |
| 5 | Marketing | 68000 |
| 6 | Engineering | 102000 |
| 7 | **Avg Eng Salary** | =AVERAGEIF(A2:A6, "Engineering", B2:B6) |

**Result:** 95000

The formula averages only the salaries where the department is "Engineering": (95000 + 88000 + 102000) / 3.
