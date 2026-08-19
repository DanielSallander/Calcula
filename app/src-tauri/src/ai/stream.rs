//! FILENAME: app/src-tauri/src/ai/stream.rs
//! PURPOSE: Turn a provider's Server-Sent-Event stream into Calcula's normalized
//!          blocks, incrementally. Pure — bytes in, events out, no I/O — so every
//!          case below is unit-tested against recorded chunk sequences.
//! CONTEXT: M6. Cloud latency hides a blocking POST; a local model generating a
//!          60-line script does not. Watching the code get written is also
//!          simply better than a spinner.
//!
//!          THE HARD PART IS TOOL CALLS, NOT TEXT. Text arrives as whole deltas
//!          and concatenating them is trivial. Tool arguments arrive as
//!          FRAGMENTS OF JSON — Anthropic sends `input_json_delta.partial_json`,
//!          OpenAI sends `tool_calls[].function.arguments` in pieces — and a
//!          fragment is not parseable on its own. `{"start_ro` is not JSON. So
//!          the accumulator concatenates per tool-call INDEX and only parses at
//!          the end. Getting this wrong does not error; it silently drops the
//!          model's arguments, and the tool runs with `{}`.
//!
//!          THE SECOND TRAP is that OpenAI identifies a streamed tool call by
//!          its `index`, and sends `id`/`name` only on the FIRST fragment.
//!          Keying on id would lose every subsequent fragment, because they
//!          carry no id at all.

use serde_json::{json, Map, Value};

use super::wire::{ChatBlock, ChatResponse, StopReason};

/// What the frontend is told as the answer arrives.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// More prose. Append it to the assistant bubble.
    #[serde(rename_all = "camelCase")]
    TextDelta { text: String },
    /// A tool call has been named. Arguments are still arriving; this exists so
    /// the transcript can show "reading cells…" before the call is complete.
    #[serde(rename_all = "camelCase")]
    ToolCallStarted { id: String, name: String },
    /// The turn is complete. Carries the same shape a non-streaming call returns,
    /// so the agentic loop is identical either way.
    #[serde(rename_all = "camelCase")]
    Done { response: ChatResponse },
    /// The stream failed part-way. Distinct from `Done` so a partial answer is
    /// never mistaken for a finished one.
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

/// One tool call being assembled from fragments.
#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    /// Concatenated JSON fragments. NOT parseable until the stream ends.
    arguments: String,
    announced: bool,
}

#[derive(Debug, Default)]
pub struct StreamAccumulator {
    text: String,
    /// Keyed by the provider's INDEX, never by id — see the module header.
    tool_calls: Vec<PartialToolCall>,
    reasoning: Vec<Value>,
    stop_reason: Option<StopReason>,
    model: String,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&mut self, index: usize) -> &mut PartialToolCall {
        while self.tool_calls.len() <= index {
            self.tool_calls.push(PartialToolCall::default());
        }
        &mut self.tool_calls[index]
    }

    /// Assemble the final response. Fragments are parsed HERE and nowhere else.
    pub fn finish(&self) -> ChatResponse {
        let mut blocks = Vec::new();
        for raw in &self.reasoning {
            blocks.push(ChatBlock::Reasoning { raw: raw.clone() });
        }
        if !self.text.is_empty() {
            blocks.push(ChatBlock::Text { text: self.text.clone() });
        }
        for call in &self.tool_calls {
            if call.name.is_empty() {
                continue;
            }
            let input = if call.arguments.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&call.arguments)
                    // Preserved rather than dropped, exactly as the non-streaming
                    // parser does: handing the model back `{}` when it sent real
                    // arguments is the silent-corruption case.
                    .unwrap_or_else(|_| json!({ "__unparsed": call.arguments }))
            };
            blocks.push(ChatBlock::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                input,
            });
        }
        let has_tool_use = blocks.iter().any(|b| matches!(b, ChatBlock::ToolUse { .. }));
        ChatResponse {
            blocks,
            // Same rule as the non-streaming path: a server that says "stop"
            // while having emitted tool calls still means the loop continues.
            stop_reason: match self.stop_reason {
                Some(StopReason::EndTurn) if has_tool_use => StopReason::ToolUse,
                Some(reason) => reason,
                None if has_tool_use => StopReason::ToolUse,
                None => StopReason::EndTurn,
            },
            model: self.model.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

/// Feed one `data:` payload from an OpenAI-compatible stream.
pub fn push_openai(acc: &mut StreamAccumulator, payload: &Value) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    if let Some(model) = payload.get("model").and_then(|m| m.as_str()) {
        if acc.model.is_empty() {
            acc.model = model.to_string();
        }
    }
    let Some(choice) = payload.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first())
    else {
        return out;
    };

    if let Some(reason) = choice.get("finish_reason").and_then(|f| f.as_str()) {
        acc.stop_reason = Some(match reason {
            "tool_calls" | "function_call" => StopReason::ToolUse,
            "length" => StopReason::MaxTokens,
            "stop" => StopReason::EndTurn,
            _ => StopReason::Other,
        });
    }

    let Some(delta) = choice.get("delta") else { return out };

    if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
        if !text.is_empty() {
            acc.text.push_str(text);
            out.push(StreamEvent::TextDelta { text: text.to_string() });
        }
    }
    if let Some(reasoning) = delta.get("reasoning_content").filter(|v| !v.is_null()) {
        acc.reasoning.push(reasoning.clone());
    }

    if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
        for call in calls {
            // Index, NOT id: only the first fragment carries an id.
            let index = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            let slot = acc.slot(index);
            if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            if let Some(func) = call.get("function") {
                if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        slot.name = name.to_string();
                    }
                }
                if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                    slot.arguments.push_str(args);
                }
            }
            if !slot.announced && !slot.name.is_empty() {
                slot.announced = true;
                let (id, name) = (slot.id.clone(), slot.name.clone());
                out.push(StreamEvent::ToolCallStarted { id, name });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/// Feed one Anthropic stream event (its `event:` name plus its `data:` payload).
pub fn push_anthropic(acc: &mut StreamAccumulator, event: &str, payload: &Value) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    match event {
        "message_start" => {
            if let Some(model) = payload
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
            {
                acc.model = model.to_string();
            }
        }
        "content_block_start" => {
            let index = payload.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            let block = payload.get("content_block");
            match block.and_then(|b| b.get("type")).and_then(|t| t.as_str()) {
                Some("tool_use") => {
                    let id = block.and_then(|b| b.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                    let name = block.and_then(|b| b.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                    let slot = acc.slot(index);
                    slot.id = id.to_string();
                    slot.name = name.to_string();
                    slot.announced = true;
                    out.push(StreamEvent::ToolCallStarted { id: id.to_string(), name: name.to_string() });
                }
                Some("thinking") | Some("redacted_thinking") => {
                    // Kept whole so it can be replayed verbatim on the next turn;
                    // Anthropic rejects a reconstructed thinking block.
                    if let Some(b) = block {
                        acc.reasoning.push(b.clone());
                    }
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let index = payload.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            let delta = payload.get("delta");
            match delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()) {
                Some("text_delta") => {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        acc.text.push_str(text);
                        out.push(StreamEvent::TextDelta { text: text.to_string() });
                    }
                }
                Some("input_json_delta") => {
                    if let Some(part) =
                        delta.and_then(|d| d.get("partial_json")).and_then(|t| t.as_str())
                    {
                        acc.slot(index).arguments.push_str(part);
                    }
                }
                Some("thinking_delta") => {
                    // Append into the reasoning block opened above, so the
                    // signature and the text stay in one object.
                    if let Some(part) = delta.and_then(|d| d.get("thinking")).and_then(|t| t.as_str()) {
                        if let Some(last) = acc.reasoning.last_mut() {
                            let existing = last
                                .get("thinking")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            if let Some(obj) = last.as_object_mut() {
                                obj.insert("thinking".into(), json!(format!("{}{}", existing, part)));
                            }
                        }
                    }
                }
                Some("signature_delta") => {
                    if let Some(sig) = delta.and_then(|d| d.get("signature")).and_then(|t| t.as_str()) {
                        if let Some(Value::Object(obj)) = acc.reasoning.last_mut() {
                            obj.insert("signature".into(), json!(sig));
                        }
                    }
                }
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(reason) = payload
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(|s| s.as_str())
            {
                acc.stop_reason = Some(match reason {
                    "end_turn" | "stop_sequence" => StopReason::EndTurn,
                    "tool_use" => StopReason::ToolUse,
                    "max_tokens" => StopReason::MaxTokens,
                    _ => StopReason::Other,
                });
            }
        }
        "error" => {
            let message = payload
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("stream error")
                .to_string();
            out.push(StreamEvent::Failed { message });
        }
        _ => {}
    }
    out
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/// One decoded SSE frame.
#[derive(Debug, Clone, PartialEq)]
pub struct SseFrame {
    /// The `event:` name. Empty when the stream sends only `data:` lines.
    pub event: String,
    pub data: String,
}

/// Incremental SSE decoder.
///
/// A network chunk boundary falls WHEREVER IT FALLS — mid-line, mid-JSON, even
/// mid-UTF-8-sequence — so frames must be assembled from a persistent buffer
/// rather than parsed per chunk. Treating each chunk as a set of lines is the
/// classic bug here: it works on a fast local socket and truncates the model's
/// output over a real network, which is exactly the case streaming exists for.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw bytes; get back whatever complete frames they finished.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseFrame> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut frames = Vec::new();

        // Frames are separated by a blank line. `\r\n` is tolerated because some
        // proxies rewrite line endings.
        loop {
            let end = match find_frame_end(&self.buffer) {
                Some(e) => e,
                None => break,
            };
            let (raw, rest) = self.buffer.split_at(end.0);
            let raw = raw.to_string();
            self.buffer = rest[end.1..].to_string();

            let mut event = String::new();
            let mut data = String::new();
            for line in raw.lines() {
                let line = line.trim_end_matches('\r');
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(v.trim_start());
                }
                // `:` comment lines and unknown fields are ignored, per the spec.
            }
            if !data.is_empty() || !event.is_empty() {
                frames.push(SseFrame { event, data });
            }
        }
        frames
    }
}

/// Offset of the frame terminator and its length.
fn find_frame_end(buffer: &str) -> Option<(usize, usize)> {
    if let Some(i) = buffer.find("\n\n") {
        return Some((i, 2));
    }
    if let Some(i) = buffer.find("\r\n\r\n") {
        return Some((i, 4));
    }
    None
}

/// `[DONE]` is OpenAI's terminator and is not JSON.
pub fn is_done_sentinel(data: &str) -> bool {
    data.trim() == "[DONE]"
}

/// Parse a frame's data as JSON, ignoring the terminator.
pub fn frame_json(data: &str) -> Option<Value> {
    if is_done_sentinel(data) {
        return None;
    }
    serde_json::from_str::<Value>(data).ok()
}

/// The map form is handy for tests that build payloads inline.
pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SSE framing ------------------------------------------------------

    #[test]
    fn a_frame_split_across_chunks_is_reassembled() {
        // The case that separates a correct decoder from one that works only on
        // localhost: the JSON is cut in half by a chunk boundary.
        let mut d = SseDecoder::new();
        assert!(d.push(b"data: {\"a\":").is_empty(), "half a frame yields nothing");
        let frames = d.push(b"1}\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frame_json(&frames[0].data).unwrap()["a"], json!(1));
    }

    #[test]
    fn several_frames_in_one_chunk_all_come_out() {
        let mut d = SseDecoder::new();
        let frames = d.push(b"data: {\"n\":1}\n\ndata: {\"n\":2}\n\ndata: {\"n\":3}\n\n");
        assert_eq!(frames.len(), 3);
        assert_eq!(frame_json(&frames[2].data).unwrap()["n"], json!(3));
    }

    #[test]
    fn event_names_and_crlf_and_comments_are_handled() {
        let mut d = SseDecoder::new();
        let frames = d.push(b": keep-alive\r\nevent: content_block_delta\r\ndata: {\"x\":1}\r\n\r\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event, "content_block_delta");
        assert_eq!(frame_json(&frames[0].data).unwrap()["x"], json!(1));
    }

    #[test]
    fn the_done_sentinel_is_recognized_and_is_not_json() {
        let mut d = SseDecoder::new();
        let frames = d.push(b"data: [DONE]\n\n");
        assert!(is_done_sentinel(&frames[0].data));
        assert!(frame_json(&frames[0].data).is_none());
    }

    #[test]
    fn a_multibyte_character_split_across_chunks_does_not_corrupt() {
        // "é" is two bytes; a chunk boundary between them must not produce a
        // replacement character in the user's text.
        let mut d = SseDecoder::new();
        let text = "data: {\"t\":\"é\"}\n\n".as_bytes().to_vec();
        let split = text.len() / 2;
        d.push(&text[..split]);
        let frames = d.push(&text[split..]);
        assert_eq!(frames.len(), 1, "frame should complete");
    }

    // ---- OpenAI-compatible ------------------------------------------------

    #[test]
    fn openai_text_deltas_accumulate_and_are_emitted_one_by_one() {
        let mut acc = StreamAccumulator::new();
        let mut seen = Vec::new();
        for piece in ["Hel", "lo ", "world"] {
            seen.extend(push_openai(
                &mut acc,
                &json!({ "model": "m", "choices": [{ "delta": { "content": piece } }] }),
            ));
        }
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0], StreamEvent::TextDelta { text: "Hel".into() });
        let done = acc.finish();
        assert_eq!(done.blocks, vec![ChatBlock::Text { text: "Hello world".into() }]);
        assert_eq!(done.model, "m");
    }

    #[test]
    fn openai_tool_arguments_are_reassembled_from_fragments() {
        // THE case this module exists for. Each fragment is unparseable alone.
        let mut acc = StreamAccumulator::new();
        push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "function": { "name": "read_cell_range", "arguments": "" } }
        ]}}]}));
        for frag in ["{\"start", "_row\":", "3}"] {
            push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": frag } }
            ]}}]}));
        }
        push_openai(&mut acc, &json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }));

        let done = acc.finish();
        assert_eq!(done.stop_reason, StopReason::ToolUse);
        match &done.blocks[0] {
            ChatBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "read_cell_range");
                assert_eq!(input["start_row"], json!(3), "fragments must be joined before parsing");
            }
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn openai_later_fragments_carry_no_id_and_must_still_land() {
        // Keying the accumulator on id instead of index loses everything after
        // the first fragment, and the tool then runs with `{}`.
        let mut acc = StreamAccumulator::new();
        push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "c1", "function": { "name": "f", "arguments": "{\"a\":" } }
        ]}}]}));
        push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "1}" } }
        ]}}]}));
        match &acc.finish().blocks[0] {
            ChatBlock::ToolUse { input, .. } => assert_eq!(input["a"], json!(1)),
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn openai_two_parallel_tool_calls_stay_separate() {
        let mut acc = StreamAccumulator::new();
        push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "a", "function": { "name": "one", "arguments": "{\"x\":1}" } },
            { "index": 1, "id": "b", "function": { "name": "two", "arguments": "{\"y\":2}" } }
        ]}}]}));
        let done = acc.finish();
        assert_eq!(done.blocks.len(), 2);
        match (&done.blocks[0], &done.blocks[1]) {
            (ChatBlock::ToolUse { name: n1, input: i1, .. }, ChatBlock::ToolUse { name: n2, input: i2, .. }) => {
                assert_eq!(n1, "one");
                assert_eq!(i1["x"], json!(1));
                assert_eq!(n2, "two");
                assert_eq!(i2["y"], json!(2));
            }
            other => panic!("expected two tool uses, got {:?}", other),
        }
    }

    #[test]
    fn openai_announces_a_tool_call_once_not_per_fragment() {
        // The transcript shows one "reading cells..." line, not thirty.
        let mut acc = StreamAccumulator::new();
        let mut announcements = 0;
        for frag in ["{\"a\"", ":1", "}"] {
            let events = push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "id": "c1", "function": { "name": "f", "arguments": frag } }
            ]}}]}));
            announcements += events.iter().filter(|e| matches!(e, StreamEvent::ToolCallStarted { .. })).count();
        }
        assert_eq!(announcements, 1);
    }

    #[test]
    fn openai_stop_with_tool_calls_still_continues_the_loop() {
        let mut acc = StreamAccumulator::new();
        push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "c1", "function": { "name": "f", "arguments": "{}" } }
        ]}}]}));
        push_openai(&mut acc, &json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }));
        assert_eq!(acc.finish().stop_reason, StopReason::ToolUse);
    }

    #[test]
    fn unparseable_streamed_arguments_are_preserved_not_silently_emptied() {
        let mut acc = StreamAccumulator::new();
        push_openai(&mut acc, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "c1", "function": { "name": "f", "arguments": "{oops" } }
        ]}}]}));
        match &acc.finish().blocks[0] {
            ChatBlock::ToolUse { input, .. } => assert_eq!(input["__unparsed"], json!("{oops")),
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    // ---- Anthropic --------------------------------------------------------

    #[test]
    fn anthropic_text_and_tool_input_stream_into_the_same_shape() {
        let mut acc = StreamAccumulator::new();
        push_anthropic(&mut acc, "message_start", &json!({ "message": { "model": "claude-x" } }));
        push_anthropic(&mut acc, "content_block_start", &json!({ "index": 0, "content_block": { "type": "text", "text": "" } }));
        let e = push_anthropic(&mut acc, "content_block_delta", &json!({ "index": 0, "delta": { "type": "text_delta", "text": "Looking" } }));
        assert_eq!(e, vec![StreamEvent::TextDelta { text: "Looking".into() }]);

        push_anthropic(&mut acc, "content_block_start", &json!({ "index": 1, "content_block": { "type": "tool_use", "id": "t1", "name": "read_cell_range" } }));
        for frag in ["{\"start", "_row\":7}"] {
            push_anthropic(&mut acc, "content_block_delta", &json!({ "index": 1, "delta": { "type": "input_json_delta", "partial_json": frag } }));
        }
        push_anthropic(&mut acc, "message_delta", &json!({ "delta": { "stop_reason": "tool_use" } }));

        let done = acc.finish();
        assert_eq!(done.model, "claude-x");
        assert_eq!(done.stop_reason, StopReason::ToolUse);
        assert!(done.blocks.iter().any(|b| matches!(b, ChatBlock::Text { text } if text == "Looking")));
        match done.blocks.iter().find(|b| matches!(b, ChatBlock::ToolUse { .. })).unwrap() {
            ChatBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "t1");
                assert_eq!(name, "read_cell_range");
                assert_eq!(input["start_row"], json!(7));
            }
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn anthropic_thinking_keeps_its_signature_across_deltas() {
        // A thinking block must go back VERBATIM, signature included, or the
        // next turn is rejected. Streamed, it arrives in three pieces.
        let mut acc = StreamAccumulator::new();
        push_anthropic(&mut acc, "content_block_start", &json!({ "index": 0, "content_block": { "type": "thinking", "thinking": "" } }));
        push_anthropic(&mut acc, "content_block_delta", &json!({ "index": 0, "delta": { "type": "thinking_delta", "thinking": "step one " } }));
        push_anthropic(&mut acc, "content_block_delta", &json!({ "index": 0, "delta": { "type": "thinking_delta", "thinking": "step two" } }));
        push_anthropic(&mut acc, "content_block_delta", &json!({ "index": 0, "delta": { "type": "signature_delta", "signature": "sig-abc" } }));

        match &acc.finish().blocks[0] {
            ChatBlock::Reasoning { raw } => {
                assert_eq!(raw["thinking"], json!("step one step two"));
                assert_eq!(raw["signature"], json!("sig-abc"));
            }
            other => panic!("expected reasoning, got {:?}", other),
        }
    }

    #[test]
    fn an_anthropic_error_event_becomes_a_failure_not_a_completion() {
        let mut acc = StreamAccumulator::new();
        let e = push_anthropic(&mut acc, "error", &json!({ "error": { "message": "overloaded" } }));
        assert_eq!(e, vec![StreamEvent::Failed { message: "overloaded".into() }]);
    }

    #[test]
    fn an_empty_stream_ends_the_turn_rather_than_looping() {
        let acc = StreamAccumulator::new();
        let done = acc.finish();
        assert!(done.blocks.is_empty());
        assert_eq!(done.stop_reason, StopReason::EndTurn);
    }

    // ---- Cross-provider ---------------------------------------------------

    #[test]
    fn both_providers_stream_the_same_conversation_into_identical_blocks() {
        // The property that makes streaming a transport detail rather than a
        // second code path: whichever vendor produced it, the agentic loop sees
        // the same thing.
        let mut a = StreamAccumulator::new();
        push_anthropic(&mut a, "content_block_start", &json!({ "index": 0, "content_block": { "type": "text", "text": "" } }));
        push_anthropic(&mut a, "content_block_delta", &json!({ "index": 0, "delta": { "type": "text_delta", "text": "hi" } }));
        push_anthropic(&mut a, "content_block_start", &json!({ "index": 1, "content_block": { "type": "tool_use", "id": "x", "name": "f" } }));
        push_anthropic(&mut a, "content_block_delta", &json!({ "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"k\":1}" } }));
        push_anthropic(&mut a, "message_delta", &json!({ "delta": { "stop_reason": "tool_use" } }));

        let mut o = StreamAccumulator::new();
        push_openai(&mut o, &json!({ "choices": [{ "delta": { "content": "hi" } }] }));
        push_openai(&mut o, &json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "x", "function": { "name": "f", "arguments": "{\"k\":1}" } }
        ]}}]}));
        push_openai(&mut o, &json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }));

        let (ra, ro) = (a.finish(), o.finish());
        assert_eq!(ra.blocks, ro.blocks);
        assert_eq!(ra.stop_reason, ro.stop_reason);
    }

    #[test]
    fn the_stream_event_wire_shape_is_camel_case_for_the_typescript_mirror() {
        let v = serde_json::to_value(StreamEvent::ToolCallStarted {
            id: "t1".into(),
            name: "read_cell_range".into(),
        })
        .unwrap();
        assert_eq!(v["type"], json!("toolCallStarted"));
        assert_eq!(v["id"], json!("t1"));

        let v2 = serde_json::to_value(StreamEvent::TextDelta { text: "x".into() }).unwrap();
        assert_eq!(v2["type"], json!("textDelta"));
    }

    #[test]
    fn obj_builds_the_map_form_tests_use() {
        assert_eq!(obj(vec![("a", json!(1))]), json!({ "a": 1 }));
    }

    // ---- Recorded from a real server ---------------------------------------

    /// Captured 2026-08-19 from Ollama
    /// (`qwen2.5-coder:3b`, `POST /v1/chat/completions`, `stream: true`).
    ///
    /// Verbatim, because every other test in this file asserts MY MODEL of the
    /// wire format rather than the format itself, and this session had already
    /// been wrong twice about what a provider actually sends. Three details here
    /// were assumptions until this capture confirmed them: `finish_reason` is
    /// `null` (not absent) on every intermediate chunk, `delta.content` is an
    /// EMPTY STRING alongside a tool call rather than omitted, and Ollama sends
    /// the whole `arguments` in ONE chunk rather than fragmenting it.
    const REAL_OLLAMA_TOOL_STREAM: &str = concat!(
        "data: {\"id\":\"chatcmpl-518\",\"object\":\"chat.completion.chunk\",\"created\":1787156348,",
        "\"model\":\"qwen2.5-coder:3b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,",
        "\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_bvbrsgtz\",",
        "\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"read_cell\",",
        "\"arguments\":\"{\\\"col\\\":2,\\\"row\\\":3}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-518\",\"object\":\"chat.completion.chunk\",\"created\":1787156348,",
        "\"model\":\"qwen2.5-coder:3b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,",
        "\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
    );

    fn drive(sse: &str, chunk_size: usize) -> ChatResponse {
        let mut decoder = SseDecoder::new();
        let mut acc = StreamAccumulator::new();
        for piece in sse.as_bytes().chunks(chunk_size) {
            for frame in decoder.push(piece) {
                if is_done_sentinel(&frame.data) {
                    continue;
                }
                if let Some(payload) = frame_json(&frame.data) {
                    push_openai(&mut acc, &payload);
                }
            }
        }
        acc.finish()
    }

    #[test]
    fn a_real_ollama_tool_stream_decodes_to_one_complete_tool_call() {
        let done = drive(REAL_OLLAMA_TOOL_STREAM, REAL_OLLAMA_TOOL_STREAM.len());
        assert_eq!(done.model, "qwen2.5-coder:3b");
        assert_eq!(done.stop_reason, StopReason::ToolUse);
        // The empty `content` must NOT become a text block.
        assert_eq!(done.blocks.len(), 1, "got {:?}", done.blocks);
        match &done.blocks[0] {
            ChatBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_bvbrsgtz");
                assert_eq!(name, "read_cell");
                assert_eq!(input["row"], json!(3));
                assert_eq!(input["col"], json!(2));
            }
            other => panic!("expected tool use, got {:?}", other),
        }
    }

    #[test]
    fn the_same_real_stream_survives_every_chunk_boundary() {
        // A real socket splits wherever it likes. Driving the SAME recorded bytes
        // at many sizes — including 1, which puts a boundary between every pair
        // of characters — is the cheapest possible proof that the decoder does
        // not depend on frames arriving whole.
        let reference = drive(REAL_OLLAMA_TOOL_STREAM, REAL_OLLAMA_TOOL_STREAM.len());
        for size in [1, 2, 3, 7, 13, 64, 255, 1024] {
            let got = drive(REAL_OLLAMA_TOOL_STREAM, size);
            assert_eq!(got.blocks, reference.blocks, "chunk size {} changed the result", size);
            assert_eq!(got.stop_reason, reference.stop_reason, "chunk size {}", size);
        }
    }
}
