//! FILENAME: tests/eval/grade-child.mjs
// PURPOSE: The subprocess half of expected-diff grading. Executes ONE candidate
//          script against one task's fixture in the outcome harness and prints
//          the observation as JSON.
// CONTEXT: docs/design/local-model-script-authoring.md §5 (L3 grading).
//
//          WHY A SUBPROCESS AT ALL. Grading means EXECUTING model output, and
//          model output is untrusted — a hostile or merely broken reply can
//          spin forever (`for (i = 0; i < n; i--)`) or reach for the machine.
//          The product runs scripts in a hardened Worker / QuickJS sandbox; a
//          dev CLI gets the cheap equivalent: a separate OS process with a
//          scrubbed environment (no API keys), Node's permission model where
//          available (no fs write, no child processes), and a hard kill from
//          the parent that no in-process loop can outlive. run-eval.mjs is the
//          only caller.
//
//          stdin:  {"task": <EvalTask>, "source": "<candidate>"}
//          stdout: one JSON OutcomeObservation
//          argv[2]: path to the esbuild bundle of the app's own modules.

const bundlePath = process.argv[2];
if (!bundlePath) {
  process.stderr.write("usage: grade-child.mjs <bundle.mjs> (payload on stdin)\n");
  process.exit(2);
}

// stdout carries EXACTLY one JSON observation. Everything below runs before
// ANY other code — including the bundle import — because a module-level
// console.log in a bundled module, or a candidate calling console.log, would
// otherwise prefix the JSON and corrupt the protocol. In the product realm
// console works but never reaches the script-output panel; muting reproduces
// that exactly (the harness captures only context.log / context.notify).
// Diagnostics still have stderr.
const stdoutWrite = process.stdout.write.bind(process.stdout);
for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
  console[level] = () => {};
}
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { task, source } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const mod = await import(`file://${bundlePath.replace(/\\/g, "/")}`);
const observation = await mod.runTaskOutcome(task, source);

// Exit EXPLICITLY once the write has flushed. Falling off the end waits for
// the event loop to drain, and a candidate that registered a live timer
// (setInterval is deliberately not neutered — the worker realm allows timers)
// would keep this process alive until the parent's 10s kill turned a finished,
// correct observation into a fabricated "runaway" failure.
stdoutWrite(JSON.stringify(observation), () => process.exit(0));
