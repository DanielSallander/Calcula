# REVERSE

Reverses the order of characters in a text string.

## Syntax

```
REVERSE(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text expression to reverse. |

## Return value

The input text with characters in reverse order.

## Remarks

- REVERSE is not part of standard DAX. It is a Calcula extension (available in Snowflake SQL).
- The reversal operates on individual characters, not on linguistic units (e.g., multi-character letters like Hungarian "dzs" are reversed character by character).
- If the input is NULL, the result is NULL.
- REVERSE generates SQL as `REVERSE(text)`.

## Example 1: Simple reversal

```
DEFINE Reversed = REVERSE(t[name])
```

If `name` is `"Hello"`, the result is `"olleH"`.

## Example 2: Combined with other functions

```
DEFINE IsPalindrome = IF(EXACT(t[word], REVERSE(t[word])), TRUE, FALSE)
```

## See also

- [LEFT](LEFT.md) — returns characters from the start of a text string
- [RIGHT](RIGHT.md) — returns characters from the end of a text string
- [MID](MID.md) — returns characters from the middle of a text string
