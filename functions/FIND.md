# FIND function

## Introduction

The FIND function locates the position of a text string within another text string. The search is case-sensitive and does not support wildcard characters. FIND returns the position number of the first character of the found text, counting from the beginning of the within_text string.

Use FIND when you need to determine where a specific substring appears within a larger string, particularly when case matters. It is commonly used in combination with MID, LEFT, and RIGHT to extract dynamic portions of text, such as parsing email addresses, isolating domain names, or splitting data at a specific delimiter.

## Syntax

```
=FIND(find_text, within_text, [start_num])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| find_text | Required | The text string to find. Case-sensitive. |
| within_text | Required | The text string to search within. |
| start_num | Optional | The character position in within_text at which to start searching. Defaults to 1 if omitted. |

## Remarks

- FIND is case-sensitive. Use SEARCH for case-insensitive matching.
- FIND does not support wildcard characters (* or ?). Use SEARCH if you need wildcard support.
- If find_text is not found within within_text, FIND returns a #VALUE! error.
- If start_num is less than 1 or greater than the length of within_text, FIND returns a #VALUE! error.
- If find_text is an empty string, FIND returns the value of start_num.

## Example

| | A | B |
|---|---|---|
| 1 | **Email** | **@ Position** |
| 2 | user@example.com | =FIND("@", A2) |
| 3 | admin@company.org | =FIND("@", A3) |

**Result:** Cell B2 returns **5** and cell B3 returns **6**.

The "@" symbol is at position 5 in the first email and position 6 in the second. You could then use this position with LEFT to extract the username: `=LEFT(A2, FIND("@", A2)-1)` would return "user".
