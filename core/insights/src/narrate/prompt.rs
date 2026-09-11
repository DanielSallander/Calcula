//! FILENAME: core/insights/src/narrate/prompt.rs
// PURPOSE: What a model is asked when it is asked to narrate — and the reply
//          shape the citation check can act on.
// CONTEXT: M6. `cite.rs` decides whether a sentence may be shown; this decides
//          what the model is told before it writes one. They belong together:
//          the prompt's rules and the checker's rules are the same rules, and a
//          prompt that asked for something the checker deletes would produce a
//          narrator that is always wrong through no fault of its own.
//
//          IT LIVES HERE, NOT IN THE EVAL RUNNER. The offline measurement
//          (`tests/eval/run-narration-eval.mjs`) reaches it through the
//          `narration` example, so the number it reports is about the prompt
//          the product will send. A runner with its own copy becomes the de
//          facto specification and is then re-typed into the product, which is
//          how two prompts start disagreeing about what a sentence may say.
//
//          THE MODEL IS NEVER SHOWN OUR SENTENCES. It gets `facts_json` —
//          numbers and ids — because a narrator that can read the deterministic
//          narration paraphrases it instead of reading the data, and then the
//          whole exercise measures a paraphrase. `lib.rs`'s `build_facts_json`
//          says the same thing and is tested for it.

use super::Locale;

/// The reply shape. One object, so a runtime with a JSON-schema mode can be
/// held to it, and every sentence carries the ids it claims to cover — without
/// which `cite::check_narration` has nothing to check against.
pub const NARRATION_SCHEMA_NAME: &str = "calcula_narration";

/// The JSON schema for that reply.
///
/// `factIds` is `minItems: 1` deliberately: a sentence citing nothing is
/// dropped by the checker anyway, and saying so in the schema turns a wasted
/// generation into one the runtime refuses to produce.
pub const NARRATION_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "sentences": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "text": { "type": "string" },
          "factIds": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
        },
        "required": ["text", "factIds"],
        "additionalProperties": false
      }
    }
  },
  "required": ["sentences"],
  "additionalProperties": false
}"#;

/// The rules a narrator is held to, in the order they matter.
///
/// The first two are the ones `cite.rs` ENFORCES, stated plainly so a model
/// that follows instructions is not punished by a check it was never told
/// about. The rest are the standards the deterministic templates already meet
/// and are tested for — `no_template_uses_causal_language` is a real test in
/// `en.rs`, and a model narrator earns no exemption from it.
fn rules(locale: Locale) -> Vec<&'static str> {
    let mut rules = vec![
        "Tag every sentence with the ids of the facts it is about. A sentence that cites no fact is discarded.",
        "Print ONLY numbers that appear in the facts you cited. Do not add, subtract, average, round differently, or convert them. A sentence containing any other number is discarded.",
        "Never say one thing caused another. The facts are statistical; they do not establish cause.",
        "Write one sentence per point. Do not open with a summary or close with a recommendation.",
        "Say nothing the facts do not contain — no advice, no target, no judgement about whether a number is good.",
    ];
    rules.push(match locale {
        Locale::En => "Write in English.",
        Locale::Sv => "Write in Swedish (svenska).",
    });
    rules
}

/// The system prompt. Byte-stable within a locale, so a provider's prefix cache
/// hits across every bundle in a session; everything that varies is the user
/// message.
pub fn system_prompt(locale: Locale) -> String {
    let mut out = String::from(
        "You put computed facts into words for a spreadsheet's insights panel. \
         The facts below were computed by Calcula and are not in question — your only \
         job is wording.\n\nRules:\n",
    );
    for rule in rules(locale) {
        out.push_str("- ");
        out.push_str(rule);
        out.push('\n');
    }
    out.push_str(
        "\nReply with JSON: {\"sentences\": [{\"text\": \"...\", \"factIds\": [\"...\"]}]}\n",
    );
    out
}

/// The user message for one bundle: the facts, as numbers and ids.
///
/// `facts_json` is passed through verbatim rather than reformatted. It is
/// already the agreed shape, it already carries exactly the ids the reply must
/// use, and re-rendering it here would be one more place for the id a model
/// sees to differ from the id the checker knows.
pub fn user_message(facts_json: &str) -> String {
    format!("Facts:\n{}\n\nWrite the sentences.", facts_json.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_prompt_is_byte_stable_within_a_locale() {
        // A prompt that varies per call defeats a provider's prefix cache, which
        // on a CPU runtime is most of the latency.
        assert_eq!(system_prompt(Locale::En), system_prompt(Locale::En));
        assert_ne!(system_prompt(Locale::En), system_prompt(Locale::Sv));
    }

    #[test]
    fn each_locale_asks_for_its_own_language() {
        assert!(system_prompt(Locale::En).contains("Write in English."));
        assert!(system_prompt(Locale::Sv).contains("Swedish"));
    }

    #[test]
    fn the_prompt_states_the_two_rules_the_checker_actually_enforces() {
        // A model punished by a rule it was never told is a model being measured
        // unfairly, and the measurement is then about the prompt rather than the
        // model. These two sentences are the ones `cite.rs` deletes for.
        let text = system_prompt(Locale::En);
        assert!(text.contains("Tag every sentence with the ids"));
        assert!(text.contains("Print ONLY numbers that appear in the facts you cited"));
    }

    #[test]
    fn the_schema_is_valid_json_and_demands_a_citation() {
        let parsed: serde_json::Value =
            serde_json::from_str(NARRATION_SCHEMA).expect("the schema is JSON");
        let fact_ids = &parsed["properties"]["sentences"]["items"]["properties"]["factIds"];
        assert_eq!(fact_ids["minItems"], 1, "an uncited sentence is dead on arrival");
        let required = parsed["properties"]["sentences"]["items"]["required"]
            .as_array()
            .expect("required is an array");
        assert!(required.iter().any(|r| r == "factIds"));
    }

    #[test]
    fn the_user_message_hands_over_the_facts_and_not_our_sentences() {
        // The whole reason `facts_json` exists: a narrator that can read the
        // deterministic narration paraphrases it instead of reading the numbers.
        let facts = r#"{"facts":[{"id":"trend:m/Revenue:","score":1.0,"kind":{"fact":"trend"}}]}"#;
        let message = user_message(facts);
        assert!(message.contains("trend:m/Revenue:"), "the ids must survive verbatim");
        assert!(message.contains(facts.trim()), "passed through, not re-rendered");
    }
}
