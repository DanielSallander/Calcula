# IF function

## Introduction

The IF function is one of the most commonly used functions in spreadsheet applications. It performs a logical test and returns one value if the condition evaluates to TRUE, and another value if it evaluates to FALSE. This allows you to make decisions within your formulas and create dynamic results based on your data.

Use IF when you need to branch your logic, such as assigning letter grades based on scores, categorizing data into groups, applying conditional calculations, or displaying different messages depending on cell values. IF functions can also be nested inside each other to handle multiple conditions, though for complex multi-condition scenarios, consider using IFS or SWITCH instead.

## Syntax

```
=IF(logical_test, value_if_true, [value_if_false])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| logical_test | Required | The condition you want to evaluate. This can be any expression that returns TRUE or FALSE. |
| value_if_true | Required | The value to return if the logical_test evaluates to TRUE. Can be a value, cell reference, formula, or text string. |
| value_if_false | Optional | The value to return if the logical_test evaluates to FALSE. If omitted, returns FALSE when the condition is not met. |

## Remarks

- If `logical_test` returns a non-boolean value, numeric values are interpreted as TRUE (non-zero) or FALSE (zero).
- You can nest up to 64 IF functions as value_if_true and value_if_false arguments to create more complex tests.
- If you need to test multiple conditions, consider using IFS, AND, OR, or SWITCH functions to simplify your formula.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Student** | **Score** | **Result** |
| 2 | Alice | 82 | =IF(B2>=70, "Pass", "Fail") |
| 3 | Bob | 55 | =IF(B3>=70, "Pass", "Fail") |

**Result:** Cell C2 returns **"Pass"** and cell C3 returns **"Fail"**.

Alice's score of 82 meets the threshold of 70, so the function returns "Pass". Bob's score of 55 does not meet the threshold, so the function returns "Fail".
