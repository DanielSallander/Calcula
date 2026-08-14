// FILENAME: app/extensions/ModelEditor/cli/lex.ts
// PURPOSE: Re-export shim — the tokenizer moved verbatim to the shared CLI
//          kernel (app/extensions/_shared/cli/lex.ts) when the fused Calcula
//          CLI was extracted. Kept so readers/writers/tests import unchanged.

export * from "../../_shared/cli/lex";
export type { LogicalLine, LexedLine, Token, ValueTok } from "../../_shared/cli/lex";
