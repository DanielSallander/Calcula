//! FILENAME: app/src-tauri/src/ai/wire.rs
//! PURPOSE: Calcula's OWN chat shape, and the translation to and from each
//!          vendor's wire format. Pure functions, no I/O — every one of them is
//!          unit-tested in both directions.
//! CONTEXT: Until 2026-08-19 the AIChat EXTENSION built Anthropic's JSON itself
//!          (`input_schema` tools, `stop_reason === "tool_use"`, `tool_use_id`
//!          blocks). That put one vendor's schema inside an extension, against
//!          the Facade Rule, and it is what made "use any model" a rewrite
//!          rather than a setting. The extension now speaks the types in THIS
//!          file and a provider renders them.
//!
//!          THE FOUR DIFFERENCES THAT ACTUALLY BITE, all handled here:
//!            1. SYSTEM PROMPT. Anthropic takes a top-level `system` field;
//!               OpenAI takes a message with role "system" at the head.
//!            2. TOOL ARGUMENTS. Anthropic's `input` is a JSON OBJECT; OpenAI's
//!               `function.arguments` is a JSON STRING that must be parsed.
//!               A provider that forgets hands the model's own arguments back
//!               to it as a quoted blob.
//!            3. TOOL RESULTS. Anthropic packs them as blocks inside ONE user
//!               message; OpenAI wants ONE message per result with role "tool".
//!               So the translation is not 1:1 — one message fans out to N.
//!            4. STOP REASON. `end_turn`/`tool_use`/`max_tokens` against
//!               `stop`/`tool_calls`/`length`. The agentic loop branches on
//!               this, so a mistranslation silently ends the conversation one
//!               turn early.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// The normalized shape
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatRole {
    User,
    Assistant,
}

/// One piece of a message. Tagged by `type` on the wire so the TypeScript
/// mirror can discriminate without guessing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatBlock {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    /// Vendor reasoning/thinking output. Round-tripped verbatim when the same
    /// provider is still selected and DROPPED when it is not — a thinking block
    /// is signed for the model that produced it and is meaningless elsewhere.
    #[serde(rename_all = "camelCase")]
    Reasoning { raw: Value },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: Vec<ChatBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments. Same object either way; only its LOCATION
    /// differs between vendors.
    pub input_schema: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub tools: Vec<ChatToolDef>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Sampling temperature. Omitted from the request when None, so a provider
    /// keeps its own default.
    ///
    /// WHY IT EXISTS. Calcula never sent one, so every turn ran at whatever the
    /// runtime chose — 0.8 for Ollama's qwen builds. Measured 2026-08-22 against
    /// a live Ollama: the SAME prompt with the SAME 24 tools produced a
    /// different tool choice on four consecutive runs, including two invented
    /// names. Which tool best answers a request is not a creative decision, and
    /// sampling it is how a model that KNOWS about `apply_formatting` reaches
    /// for `formatSelectedCellsBackgroundColor` instead.
    #[serde(default)]
    pub temperature: Option<f32>,
    /// A JSON Schema the reply must conform to.
    ///
    /// WHY IT EXISTS. A formula, an intent classification and an insight
    /// narration are all requests for a SHAPE, not for prose, and a small local
    /// model asked for prose will happily wrap the answer in three sentences of
    /// preamble. Measured against Ollama 0.33.1 on 2026-09-07, a 1B model
    /// returned a conforming object for a schema-constrained request and
    /// unrelated well-formed JSON for a bare `{"type":"json_object"}` — so this
    /// carries the SCHEMA or nothing, never the loose mode.
    ///
    /// Both vendors are served, differently: OpenAI-compatible endpoints take a
    /// `response_format`, and Anthropic has no such field, so the schema becomes
    /// a single forced tool whose input is unwrapped back into text by
    /// [`normalize_schema_response`]. A caller therefore sees JSON text either
    /// way and needs to know nothing about the vendor.
    #[serde(default)]
    pub response_schema: Option<ResponseSchema>,
    /// A GBNF grammar, for runtimes that accept one.
    ///
    /// Stronger than a JSON schema and answers a different failure: a schema
    /// constrains the ENVELOPE, a grammar constrains the CONTENT, so a
    /// grammar-constrained formula cannot be syntactically invalid at all. That
    /// matters here — measured on the eval corpus, 11 of 60 formulas from a 1.5B
    /// coder model failed to PARSE, and 36 of 60 from a 1B.
    ///
    /// Only llama.cpp's own server implements it; Ollama's OpenAI-compatible
    /// endpoint has no such field and ignores the extra key. Callers set this
    /// only for providers whose profile says it is honoured.
    #[serde(default)]
    pub grammar: Option<String>,
}

/// A named JSON Schema for a constrained reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseSchema {
    /// Names the schema for OpenAI and names the forced TOOL for Anthropic, so
    /// the two renderings cannot drift apart.
    pub name: String,
    pub schema: Value,
    /// OpenAI's strict mode. Ignored by every other runtime.
    #[serde(default)]
    pub strict: bool,
}

/// Unwrap a forced-tool reply back into JSON text.
///
/// Anthropic cannot be told "reply with this shape", only "call this tool", so a
/// schema-constrained request there comes back as a `tool_use` block whose input
/// IS the answer. Every caller would otherwise have to know that, and would have
/// to know it per vendor. Applied on both the buffered and streamed paths.
///
/// A reply that carries no matching tool use is returned untouched: the model
/// declined, or the runtime ignored the constraint, and either way inventing a
/// result here would be worse than passing on what actually arrived.
pub fn normalize_schema_response(req: &ChatRequest, resp: ChatResponse) -> ChatResponse {
    let Some(schema) = req.response_schema.as_ref() else {
        return resp;
    };
    let input = resp.blocks.iter().find_map(|b| match b {
        ChatBlock::ToolUse { name, input, .. } if name == &schema.name => Some(input.clone()),
        _ => None,
    });
    match input {
        Some(value) => ChatResponse {
            blocks: vec![ChatBlock::Text {
                text: serde_json::to_string(&value).unwrap_or_default(),
            }],
            stop_reason: StopReason::EndTurn,
            model: resp.model,
        },
        None => resp,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub blocks: Vec<ChatBlock>,
    pub stop_reason: StopReason,
    pub model: String,
}

pub const DEFAULT_MAX_TOKENS: u32 = 16000;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

fn anthropic_block(block: &ChatBlock) -> Option<Value> {
    Some(match block {
        ChatBlock::Text { text } => json!({ "type": "text", "text": text }),
        ChatBlock::ToolUse { id, name, input } => {
            json!({ "type": "tool_use", "id": id, "name": name, "input": input })
        }
        ChatBlock::ToolResult { tool_use_id, content, is_error } => json!({
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
            "is_error": is_error,
        }),
        // Passed back verbatim: Anthropic requires the original block, signature
        // included, for a thinking turn to continue.
        ChatBlock::Reasoning { raw } => raw.clone(),
    })
}

pub fn anthropic_request_body(req: &ChatRequest) -> Value {
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            json!({
                "role": match m.role { ChatRole::User => "user", ChatRole::Assistant => "assistant" },
                "content": m.content.iter().filter_map(anthropic_block).collect::<Vec<_>>(),
            })
        })
        .collect();

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": messages,
    });
    if let Some(sys) = req.system.as_ref().filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(sys);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                    })
                })
                .collect(),
        );
    }
    // A schema becomes one FORCED tool. Anthropic has no `response_format`, and
    // `tool_choice` is the only way to say "the reply must be this shape". The
    // tool is appended to whatever tools the caller already sent rather than
    // replacing them, so a request cannot silently lose its tool surface.
    if let Some(schema) = &req.response_schema {
        let mut tools = match body.get("tools").and_then(|t| t.as_array()) {
            Some(existing) => existing.clone(),
            None => Vec::new(),
        };
        tools.push(json!({
            "name": schema.name,
            "description": "Return the answer in this exact shape.",
            "input_schema": schema.schema,
        }));
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = json!({ "type": "tool", "name": schema.name });
    }
    body
}

pub fn anthropic_parse_response(raw: &Value) -> Result<ChatResponse, String> {
    let content = raw
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| "Anthropic response has no `content` array".to_string())?;

    let mut blocks = Vec::new();
    for item in content {
        match item.get("type").and_then(|t| t.as_str()) {
            Some("text") => blocks.push(ChatBlock::Text {
                text: item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            }),
            Some("tool_use") => blocks.push(ChatBlock::ToolUse {
                id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                input: item.get("input").cloned().unwrap_or(json!({})),
            }),
            // thinking / redacted_thinking / anything new: keep it whole.
            Some(_) => blocks.push(ChatBlock::Reasoning { raw: item.clone() }),
            None => {}
        }
    }

    Ok(ChatResponse {
        blocks,
        stop_reason: match raw.get("stop_reason").and_then(|s| s.as_str()) {
            Some("end_turn") | Some("stop_sequence") => StopReason::EndTurn,
            Some("tool_use") => StopReason::ToolUse,
            Some("max_tokens") => StopReason::MaxTokens,
            _ => StopReason::Other,
        },
        model: raw.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string(),
    })
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Azure, Groq, Together, OpenRouter, Ollama,
// LM Studio, llama.cpp, vLLM, DeepSeek, Mistral, xAI, Gemini's compat endpoint)
// ---------------------------------------------------------------------------

pub fn openai_request_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // Difference 1: the system prompt is a MESSAGE here, and must lead.
    if let Some(sys) = req.system.as_ref().filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": sys }));
    }

    for m in &req.messages {
        // Difference 3: tool results are their own messages, one per result,
        // and must not be merged into the user turn that carried them.
        let results: Vec<&ChatBlock> = m
            .content
            .iter()
            .filter(|b| matches!(b, ChatBlock::ToolResult { .. }))
            .collect();
        for block in &results {
            if let ChatBlock::ToolResult { tool_use_id, content, .. } = block {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": content,
                }));
            }
        }

        let text: String = m
            .content
            .iter()
            .filter_map(|b| match b {
                ChatBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");

        let tool_calls: Vec<Value> = m
            .content
            .iter()
            .filter_map(|b| match b {
                ChatBlock::ToolUse { id, name, input } => Some(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        // Difference 2: arguments travel as a STRING here.
                        "arguments": serde_json::to_string(input).unwrap_or_else(|_| "{}".into()),
                    },
                })),
                _ => None,
            })
            .collect();

        if text.is_empty() && tool_calls.is_empty() {
            continue;
        }
        let role = match m.role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        };
        let mut msg = Map::new();
        msg.insert("role".into(), json!(role));
        // An assistant turn that is ONLY tool calls still needs a content key;
        // several compatible servers reject the message without one.
        msg.insert("content".into(), if text.is_empty() { Value::Null } else { json!(text) });
        if !tool_calls.is_empty() {
            msg.insert("tool_calls".into(), Value::Array(tool_calls));
        }
        messages.push(Value::Object(msg));
    }

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": messages,
    });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(schema) = &req.response_schema {
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {
                "name": schema.name,
                "schema": schema.schema,
                "strict": schema.strict,
            },
        });
    }
    // llama.cpp's own server field. Every other runtime ignores an unknown key
    // (verified against Ollama), so sending it is safe where it is not honoured
    // — but a caller should still set it only where the profile says it is.
    if let Some(grammar) = &req.grammar {
        body["grammar"] = json!(grammar);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        },
                    })
                })
                .collect(),
        );
    }
    body
}

pub fn openai_parse_response(raw: &Value) -> Result<ChatResponse, String> {
    let choice = raw
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .ok_or_else(|| "Response has no `choices` array".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "Response choice has no `message`".to_string())?;

    let mut blocks = Vec::new();
    if let Some(text) = message.get("content").and_then(|c| c.as_str()) {
        if !text.is_empty() {
            blocks.push(ChatBlock::Text { text: text.to_string() });
        }
    }
    // Some compatible servers put reasoning beside the content.
    if let Some(reasoning) = message.get("reasoning_content").filter(|v| !v.is_null()) {
        blocks.push(ChatBlock::Reasoning { raw: reasoning.clone() });
    }

    if let Some(calls) = message.get("tool_calls").and_then(|c| c.as_array()) {
        for call in calls {
            let func = call.get("function");
            let name = func
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            // Difference 2 again, in reverse: parse the STRING back to an object.
            // A server that (wrongly) sends an object is accepted as-is rather
            // than being stringified into uselessness.
            let raw_args = func.and_then(|f| f.get("arguments"));
            let input = match raw_args {
                Some(Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or_else(|_| json!({ "__unparsed": s }))
                }
                Some(other) => other.clone(),
                None => json!({}),
            };
            blocks.push(ChatBlock::ToolUse {
                id: call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name,
                input,
            });
        }
    }

    let finish = choice.get("finish_reason").and_then(|f| f.as_str());
    let has_tool_use = blocks.iter().any(|b| matches!(b, ChatBlock::ToolUse { .. }));
    Ok(ChatResponse {
        blocks,
        // Difference 4. `has_tool_use` is consulted because several compatible
        // servers report "stop" while still emitting tool_calls; trusting the
        // label alone would end the agentic loop with calls left unrun.
        stop_reason: match finish {
            Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
            Some("length") => StopReason::MaxTokens,
            Some("stop") if has_tool_use => StopReason::ToolUse,
            Some("stop") => StopReason::EndTurn,
            _ if has_tool_use => StopReason::ToolUse,
            _ => StopReason::Other,
        },
        model: raw.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> ChatRequest {
        ChatRequest {
            provider_id: "test".into(),
            model: "m-1".into(),
            system: Some("be brief".into()),
            messages: vec![
                ChatMessage {
                    role: ChatRole::User,
                    content: vec![ChatBlock::Text { text: "sum column B".into() }],
                },
                ChatMessage {
                    role: ChatRole::Assistant,
                    content: vec![ChatBlock::ToolUse {
                        id: "call_1".into(),
                        name: "read_cell_range".into(),
                        input: json!({ "start_row": 0, "end_row": 9 }),
                    }],
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: vec![
                        ChatBlock::ToolResult {
                            tool_use_id: "call_1".into(),
                            content: "1,2,3".into(),
                            is_error: false,
                        },
                        ChatBlock::ToolResult {
                            tool_use_id: "call_2".into(),
                            content: "boom".into(),
                            is_error: true,
                        },
                    ],
                },
            ],
            tools: vec![ChatToolDef {
                name: "read_cell_range".into(),
                description: "Read a range".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
            }],
            max_tokens: Some(1234),
            temperature: Some(0.0),
            response_schema: None,
            grammar: None,
        }
    }

    // ---- Anthropic --------------------------------------------------------

    #[test]
    fn anthropic_puts_the_system_prompt_in_its_own_field_and_keeps_tool_input_an_object() {
        let body = anthropic_request_body(&sample_request());
        assert_eq!(body["system"], json!("be brief"));
        assert_eq!(body["max_tokens"], json!(1234));
        assert_eq!(body["tools"][0]["input_schema"]["type"], json!("object"));
        // The tool_use input is an OBJECT, not a string.
        assert!(body["messages"][1]["content"][0]["input"].is_object());
        assert_eq!(body["messages"][1]["content"][0]["type"], json!("tool_use"));
    }

    #[test]
    fn anthropic_keeps_both_tool_results_inside_one_user_message() {
        let body = anthropic_request_body(&sample_request());
        let third = &body["messages"][2];
        assert_eq!(third["role"], json!("user"));
        assert_eq!(third["content"].as_array().unwrap().len(), 2);
        assert_eq!(third["content"][1]["is_error"], json!(true));
    }

    #[test]
    fn anthropic_response_round_trips_text_tool_use_and_thinking() {
        let raw = json!({
            "model": "claude-x",
            "stop_reason": "tool_use",
            "content": [
                { "type": "thinking", "thinking": "hmm", "signature": "sig" },
                { "type": "text", "text": "looking" },
                { "type": "tool_use", "id": "t1", "name": "read_cell_range", "input": { "a": 1 } }
            ]
        });
        let parsed = anthropic_parse_response(&raw).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::ToolUse);
        assert_eq!(parsed.model, "claude-x");
        assert_eq!(parsed.blocks.len(), 3);
        // The thinking block survives WHOLE, signature included: Anthropic
        // rejects a continued thinking turn whose block was reconstructed.
        match &parsed.blocks[0] {
            ChatBlock::Reasoning { raw } => assert_eq!(raw["signature"], json!("sig")),
            other => panic!("expected reasoning, got {:?}", other),
        }
        // ...and it goes back out unchanged.
        let echoed = anthropic_request_body(&ChatRequest {
            provider_id: "a".into(),
            model: "m".into(),
            system: None,
            messages: vec![ChatMessage { role: ChatRole::Assistant, content: parsed.blocks.clone() }],
            tools: vec![],
            max_tokens: None,
            temperature: None,
            response_schema: None,
            grammar: None,
        });
        assert_eq!(echoed["messages"][0]["content"][0]["signature"], json!("sig"));
    }

    // ---- OpenAI-compatible ------------------------------------------------

    #[test]
    fn openai_leads_with_a_system_message_rather_than_a_field() {
        let body = openai_request_body(&sample_request());
        assert!(body.get("system").is_none(), "system must not be a top-level field");
        assert_eq!(body["messages"][0]["role"], json!("system"));
        assert_eq!(body["messages"][0]["content"], json!("be brief"));
    }

    #[test]
    fn openai_serializes_tool_arguments_as_a_json_string() {
        let body = openai_request_body(&sample_request());
        let call = &body["messages"][2]["tool_calls"][0];
        let args = call["function"]["arguments"].as_str().expect("arguments must be a STRING");
        // ...and it must be the real arguments, not a quoted blob.
        let reparsed: Value = serde_json::from_str(args).unwrap();
        assert_eq!(reparsed["start_row"], json!(0));
        assert_eq!(call["type"], json!("function"));
    }

    #[test]
    fn openai_fans_two_tool_results_out_into_two_role_tool_messages() {
        let body = openai_request_body(&sample_request());
        let msgs = body["messages"].as_array().unwrap();
        let tool_msgs: Vec<&Value> = msgs.iter().filter(|m| m["role"] == json!("tool")).collect();
        assert_eq!(tool_msgs.len(), 2, "one message per result, never merged");
        assert_eq!(tool_msgs[0]["tool_call_id"], json!("call_1"));
        assert_eq!(tool_msgs[1]["tool_call_id"], json!("call_2"));
    }

    #[test]
    fn openai_puts_the_tool_schema_under_function_parameters() {
        let body = openai_request_body(&sample_request());
        assert_eq!(body["tools"][0]["type"], json!("function"));
        assert_eq!(body["tools"][0]["function"]["name"], json!("read_cell_range"));
        assert_eq!(body["tools"][0]["function"]["parameters"]["type"], json!("object"));
    }

    #[test]
    fn openai_response_parses_arguments_back_into_an_object() {
        let raw = json!({
            "model": "qwen",
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "c1",
                        "type": "function",
                        "function": { "name": "read_cell_range", "arguments": "{\"start_row\":3}" }
                    }]
                }
            }]
        });
        let parsed = openai_parse_response(&raw).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::ToolUse);
        match &parsed.blocks[0] {
            ChatBlock::ToolUse { input, name, .. } => {
                assert_eq!(name, "read_cell_range");
                assert_eq!(input["start_row"], json!(3), "arguments must be PARSED, not left a string");
            }
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn openai_tolerates_a_server_that_sends_arguments_as_an_object() {
        // Out of spec, and several local runtimes do it. Stringifying it into
        // the model's own input would be worse than accepting it.
        let raw = json!({
            "choices": [{ "finish_reason": "tool_calls", "message": {
                "tool_calls": [{ "id": "c1", "function": { "name": "f", "arguments": { "x": 1 } } }]
            }}]
        });
        match &openai_parse_response(&raw).unwrap().blocks[0] {
            ChatBlock::ToolUse { input, .. } => assert_eq!(input["x"], json!(1)),
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn openai_unparseable_arguments_are_preserved_rather_than_dropped() {
        let raw = json!({
            "choices": [{ "finish_reason": "tool_calls", "message": {
                "tool_calls": [{ "id": "c1", "function": { "name": "f", "arguments": "{not json" } }]
            }}]
        });
        match &openai_parse_response(&raw).unwrap().blocks[0] {
            ChatBlock::ToolUse { input, .. } => assert_eq!(input["__unparsed"], json!("{not json")),
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn a_server_reporting_stop_while_emitting_tool_calls_still_continues_the_loop() {
        // Measured behaviour of several OpenAI-compatible local servers. Trusting
        // the label would end the conversation with the call never run, which
        // reads to the user as the model ignoring them.
        let raw = json!({
            "choices": [{ "finish_reason": "stop", "message": {
                "content": "I will read it",
                "tool_calls": [{ "id": "c1", "function": { "name": "f", "arguments": "{}" } }]
            }}]
        });
        assert_eq!(openai_parse_response(&raw).unwrap().stop_reason, StopReason::ToolUse);
    }

    #[test]
    fn a_plain_text_answer_ends_the_turn() {
        let raw = json!({
            "choices": [{ "finish_reason": "stop", "message": { "content": "42" } }]
        });
        let parsed = openai_parse_response(&raw).unwrap();
        assert_eq!(parsed.stop_reason, StopReason::EndTurn);
        assert_eq!(parsed.blocks, vec![ChatBlock::Text { text: "42".into() }]);
    }

    fn schema_request() -> ChatRequest {
        let mut req = sample_request();
        req.tools.clear();
        req.response_schema = Some(ResponseSchema {
            name: "calcula_formula_proposal".into(),
            schema: json!({
                "type": "object",
                "properties": { "formula": { "type": "string" } },
                "required": ["formula"],
                "additionalProperties": false,
            }),
            strict: true,
        });
        req
    }

    #[test]
    fn a_schema_becomes_a_response_format_on_an_openai_endpoint() {
        let body = openai_request_body(&schema_request());
        assert_eq!(body["response_format"]["type"], json!("json_schema"));
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            json!("calcula_formula_proposal")
        );
        assert_eq!(body["response_format"]["json_schema"]["strict"], json!(true));
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["required"][0],
            json!("formula")
        );
        // Omitted entirely when unset, so a runtime that rejects an unknown key
        // is never handed one.
        assert!(openai_request_body(&sample_request()).get("response_format").is_none());
    }

    #[test]
    fn a_schema_becomes_one_forced_tool_on_anthropic() {
        // Anthropic has no `response_format`. The only way to demand a shape is
        // to offer exactly one tool and require it.
        let body = anthropic_request_body(&schema_request());
        assert_eq!(body["tool_choice"], json!({ "type": "tool", "name": "calcula_formula_proposal" }));
        assert_eq!(body["tools"][0]["name"], json!("calcula_formula_proposal"));
        assert_eq!(body["tools"][0]["input_schema"]["required"][0], json!("formula"));
        assert!(anthropic_request_body(&sample_request()).get("tool_choice").is_none());
    }

    #[test]
    fn the_forced_tool_does_not_displace_the_callers_own_tools() {
        // A request that carries both a tool surface and a schema must keep the
        // surface; dropping it would silently disarm the caller's tools.
        let mut req = sample_request();
        req.response_schema = schema_request().response_schema;
        let body = anthropic_request_body(&req);
        let tools = body["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2, "the caller's tool plus the forced one");
        assert_eq!(tools[0]["name"], json!("read_cell_range"));
        assert_eq!(tools[1]["name"], json!("calcula_formula_proposal"));
    }

    #[test]
    fn a_forced_tool_reply_is_normalized_back_to_json_text() {
        // So a caller never has to know which vendor answered.
        let req = schema_request();
        let resp = ChatResponse {
            blocks: vec![ChatBlock::ToolUse {
                id: "t1".into(),
                name: "calcula_formula_proposal".into(),
                input: json!({ "formula": "=SUM(A1:A3)" }),
            }],
            stop_reason: StopReason::ToolUse,
            model: "m".into(),
        };
        let out = normalize_schema_response(&req, resp);
        assert_eq!(out.stop_reason, StopReason::EndTurn);
        match &out.blocks[0] {
            ChatBlock::Text { text } => {
                assert_eq!(serde_json::from_str::<Value>(text).unwrap()["formula"], json!("=SUM(A1:A3)"));
            }
            other => panic!("expected text, got {:?}", other),
        }
    }

    #[test]
    fn a_reply_with_no_matching_tool_use_passes_through_untouched() {
        // The model declined, or the runtime ignored the constraint. Inventing a
        // result here would be worse than reporting what arrived.
        let req = schema_request();
        let resp = ChatResponse {
            blocks: vec![ChatBlock::Text { text: "I cannot do that".into() }],
            stop_reason: StopReason::EndTurn,
            model: "m".into(),
        };
        let out = normalize_schema_response(&req, resp.clone());
        assert_eq!(out.blocks, resp.blocks);
    }

    #[test]
    fn a_grammar_reaches_the_openai_body_and_is_omitted_when_unset() {
        let mut req = sample_request();
        req.grammar = Some("root ::= \"=\" [A-Z]+".into());
        assert_eq!(openai_request_body(&req)["grammar"], json!("root ::= \"=\" [A-Z]+"));
        assert!(openai_request_body(&sample_request()).get("grammar").is_none());
    }

    #[test]
    fn temperature_reaches_both_vendors_and_is_omitted_when_unset() {
        // Calcula sent NO temperature until 2026-08-22, so every turn ran at the
        // runtime's own default (0.8 for Ollama's qwen builds). Measured against
        // a live Ollama: four identical requests, four different tool choices,
        // two of them invented names. Tool selection is not a creative decision.
        let req = sample_request();
        assert_eq!(openai_request_body(&req)["temperature"], json!(0.0));
        assert_eq!(anthropic_request_body(&req)["temperature"], json!(0.0));

        // Omitted entirely when None, so a provider keeps its own default rather
        // than being handed a null it may reject.
        let mut unset = sample_request();
        unset.temperature = None;
        assert!(openai_request_body(&unset).get("temperature").is_none());
        assert!(anthropic_request_body(&unset).get("temperature").is_none());
    }

    #[test]
    fn malformed_responses_are_errors_rather_than_empty_successes() {
        assert!(openai_parse_response(&json!({})).is_err());
        assert!(openai_parse_response(&json!({ "choices": [] })).is_err());
        assert!(anthropic_parse_response(&json!({})).is_err());
    }

    // ---- Cross-provider ---------------------------------------------------

    #[test]
    fn the_same_conversation_reaches_both_vendors_with_every_tool_call_intact() {
        // The property that matters for a model PICKER: switching provider must
        // not lose a turn. Both renderings must carry the same tool call and the
        // same two results.
        let req = sample_request();
        let a = anthropic_request_body(&req);
        let o = openai_request_body(&req);

        assert_eq!(a["messages"][1]["content"][0]["name"], json!("read_cell_range"));
        assert_eq!(o["messages"][2]["tool_calls"][0]["function"]["name"], json!("read_cell_range"));

        let a_results = a["messages"][2]["content"].as_array().unwrap().len();
        let o_results = o["messages"].as_array().unwrap().iter().filter(|m| m["role"] == json!("tool")).count();
        assert_eq!(a_results, o_results, "no tool result may be lost in either rendering");
    }

    #[test]
    fn the_normalized_shape_serializes_camelCase_for_the_typescript_mirror() {
        let block = ChatBlock::ToolResult {
            tool_use_id: "t1".into(),
            content: "ok".into(),
            is_error: true,
        };
        let v = serde_json::to_value(&block).unwrap();
        assert_eq!(v["type"], json!("toolResult"));
        assert_eq!(v["toolUseId"], json!("t1"));
        assert_eq!(v["isError"], json!(true));
        // ...and back.
        let round: ChatBlock = serde_json::from_value(v).unwrap();
        assert_eq!(round, block);
    }
}
