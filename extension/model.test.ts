// Run with: node --test extension/
import { test } from "node:test";
import assert from "node:assert/strict";
import { code, cutLines, quote, defaultRender, draftText, type Entry, type Item, parseInput, plan, statusLine, statusText, stripComments, toItems } from "./model.ts";

const hideToolOnly = { ...defaultRender, toolOnlyTurns: false };
const lines = { ...defaultRender, toolDetails: "off" as const }; // compact lines, for tests about marks

// ---- builders ----

const user = (id: string, text: string): Entry => ({ type: "message", id, message: { role: "user", content: text } });
const assistant = (id: string, text: string, calls: string[] = [], stopReason = calls.length ? "toolUse" : "stop"): Entry => ({
  type: "message",
  id,
  message: {
    role: "assistant",
    stopReason,
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text },
      ...calls.map((c) => ({ type: "toolCall" as const, id: c, name: "bash", arguments: { command: `run ${c}` } })),
    ],
  },
});
const result = (id: string, call: string, isError = false): Entry => ({
  type: "message",
  id,
  message: { role: "toolResult", toolCallId: call, isError, content: [] },
});
const item = (key: string, endsRun = false): Item => ({ key, text: key, endsRun });
const keys = (items: Item[]) => items.map((i) => i.key);

// ---- toItems ----

test("a turn shows its text and tool marks, and hides thinking", () => {
  const items = toItems([user("u1", "go"), assistant("a1", "Running.", ["c1", "c2"]), result("r1", "c1"), result("r2", "c2", true)], undefined, lines);
  assert.deepEqual(items[0], { key: "u1", text: "👤\n\n> go", userText: "go", endsRun: false });
  assert.deepEqual(items[1], { key: "a1", text: "Running.\n\n- ✓ bash `run c1`\n- ✗ bash `run c2`", endsRun: false });
});

test("a turn waits for its tool results", () => {
  const entries = [user("u1", "go"), assistant("a1", "Running.", ["c1", "c2"]), result("r1", "c1")];
  assert.deepEqual(keys(toItems(entries)), ["u1"]);
});

test("an aborted turn is posted once turn_end names it, with ⊘ for skipped calls", () => {
  const entries = [user("u1", "go"), assistant("a1", "Running.", ["c1", "c2"], "aborted"), result("r1", "c1")];
  const items = toItems(entries, "a1", lines);
  assert.deepEqual(keys(items), ["u1", "a1"]);
  assert.equal(items[1].text, "Running.\n\n- ✓ bash `run c1`\n- ⊘ bash `run c2`\n\n⚠️ aborted");
  assert.equal(items[1].endsRun, true);
});

test("a turn followed by anything is finished", () => {
  const entries = [assistant("a1", "Running.", ["c1"]), user("u2", "next")];
  assert.deepEqual(keys(toItems(entries)), ["a1", "u2"]);
});

test("tool-only turns can be hidden", () => {
  const entries = [assistant("a1", "", ["c1"]), result("r1", "c1"), assistant("a2", "Looked.", ["c2"]), result("r2", "c2")];
  assert.deepEqual(keys(toItems(entries)), ["a1", "a2"]);
  assert.deepEqual(keys(toItems(entries, undefined, hideToolOnly)), ["a2"]);
  // an aborted tool-only turn still shows, because it carries a status
  const aborted = [assistant("a1", "", ["c1"], "aborted")];
  assert.deepEqual(keys(toItems(aborted, "a1", hideToolOnly)), ["a1"]);
});

// a turn with one call, and that call's result
const call = (name: string, args: Record<string, unknown>): Entry => ({
  type: "message",
  id: "a1",
  message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name, arguments: args }] },
});
const output = (text: string, extra: Partial<Entry["message"] & object> = {}): Entry => ({
  type: "message",
  id: "r1",
  message: { role: "toolResult", toolCallId: "c1", isError: false, content: [{ type: "text", text }], ...extra },
});

test("tool output is collapsed by default, expanded or off by option", () => {
  const entries = [call("bash", { command: "ls" }), output("a.go\nb.go")];
  const body = "```\na.go\nb.go\n```";
  assert.equal(toItems(entries)[0].text, `<details><summary>✓ bash \`ls\`</summary>\n\n${body}\n\n</details>`);
  assert.equal(toItems(entries, undefined, { ...defaultRender, toolDetails: "expanded" })[0].text, `✓ bash \`ls\`\n\n${body}`);
  assert.equal(toItems(entries, undefined, { ...defaultRender, toolDetails: "off" })[0].text, "- ✓ bash `ls`");
});

test("every call is a section, with a note when there is no output", () => {
  const entries = [assistant("a1", "", ["c1", "c2"], "aborted"), result("r1", "c1")];
  assert.equal(
    toItems(entries, "a1")[0].text,
    "<details><summary>✓ bash `run c1`</summary>\n\n_no output_\n\n</details>\n\n" +
      "<details><summary>⊘ bash `run c2`</summary>\n\n_not run_\n\n</details>\n\n⚠️ aborted",
  );
});

test("an edit shows its diff; read shows no contents", () => {
  const edit = [call("edit", { path: "a.go" }), output("Edited a.go", { details: { patch: "-a\n+b" } })];
  assert.equal(toItems(edit)[0].text, "<details><summary>✓ edit `a.go`</summary>\n\n```diff\n-a\n+b\n```\n\n</details>");
  const failed = [call("edit", { path: "a.go" }), output("oldText not found", { isError: true, details: { patch: "-a\n+b" } })];
  assert.match(toItems(failed)[0].text, /✗ edit `a.go`<\/summary>\n\n```\noldText not found\n```/);
  assert.equal(toItems([call("read", { path: "a.go" }), output("package main")])[0].text, "<details><summary>✓ read `a.go`</summary>\n\n_contents not shown_\n\n</details>");
  const missing = [call("read", { path: "x.go" }), output("ENOENT: no such file", { isError: true })];
  assert.match(toItems(missing)[0].text, /✗ read `x.go`<\/summary>\n\n```\nENOENT/); // errors still show
});

test("shell output keeps its tail; over budget, bodies become a note", () => {
  const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const text = toItems([call("bash", { command: "seq" }), output(long)])[0].text;
  assert.match(text, /… \(\d+ earlier lines\)\nline \d+/);
  assert.match(text, /line 1999\n```/);
  const many: Entry = {
    type: "message",
    id: "a1",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: Array.from({ length: 20 }, (_, i) => ({ type: "toolCall" as const, id: `c${i}`, name: "bash", arguments: { command: `c${i}` } })),
    },
  };
  const results = Array.from({ length: 20 }, (_, i): Entry => ({
    type: "message",
    id: `r${i}`,
    message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: long }] },
  }));
  const all = toItems([many, ...results])[0].text;
  assert.ok(all.length <= 30000, `${all.length} characters`);
  assert.match(all, /✓ bash `c19`<\/summary>\n\n_output omitted: message too long_\n\n<\/details>$/);
});

test("long output is cut at a line boundary", () => {
  assert.equal(cutLines("aaa\nbbb\nccc", 8), "aaa\nbbb\n… (1 more lines)");
  assert.equal(cutLines("aaa\nbbb\nccc", 8, true), "… (1 earlier lines)\nbbb\nccc");
  assert.equal(cutLines("short", 8), "short");
});
test("a turn without tool calls ends the run", () => {
  assert.equal(toItems([assistant("a1", "Done.")])[0].endsRun, true);
});

test("other entries", () => {
  const items = toItems([
    { type: "compaction", id: "c", summary: "S" },
    { type: "model_change", id: "m", provider: "openai", modelId: "gpt-4o" },
    { type: "thinking_level_change", id: "t", thinkingLevel: "high" },
    { type: "label", id: "l" },
  ]);
  assert.deepEqual(
    items.map((i) => i.text),
    ["🗜 **Compacted**\n\nS", "_model → openai/gpt-4o_", "_thinking → high_"],
  );
});

// ---- plan ----

test("live: new items follow the topic's end", () => {
  const posts = plan([item("u1"), item("a1", true)], ["u1"], new Map(), 20);
  assert.deepEqual(posts, [{ key: "a1", text: "a1", notify: true }]);
});

test("first attach replays the last items", () => {
  const posts = plan([item("u1"), item("a1"), item("u2")], [], new Map(), 2);
  assert.deepEqual(posts, [
    { text: "… 1 earlier messages not shown" },
    { key: "a1", text: "a1" },
    { key: "u2", text: "u2" },
  ]);
});

test("after a limited replay, a new item doesn't repost the skipped history", () => {
  // First attach showed only a2, u3; a new message u4 arrives.
  const items = [item("u1"), item("a1"), item("u2"), item("a2"), item("u3"), item("u4")];
  assert.deepEqual(plan(items, ["a2", "u3"], new Map(), 2), [{ key: "u4", text: "u4" }]);
});

test("a fork from before anything shown is limited by replay too", () => {
  const posts = plan([item("x1"), item("x2"), item("x3")], ["a1"], new Map(), 1);
  assert.deepEqual(posts, [
    { text: "🌿 Branched from an earlier point" },
    { text: "… 2 earlier messages not shown" },
    { key: "x3", text: "x3" },
  ]);
});

test("/tree posts a marker replying to the fork point", () => {
  const posts = plan([item("u1"), item("a1"), item("u3")], ["u1", "a1", "u2", "a2"], new Map(), 20);
  assert.deepEqual(posts, [
    { text: "🌿 Branched from here", replyTo: "a1" },
    { key: "u3", text: "u3" },
  ]);
});

test("a fork point that was never posted", () => {
  const posts = plan([item("x1"), item("x2")], ["a1"], new Map(), 20);
  assert.deepEqual(posts[0], { text: "🌿 Branched from an earlier point" });
});

test("nothing new, nothing posted", () => {
  assert.deepEqual(plan([item("u1")], ["u1"], new Map(), 20), []);
});

test("messages typed in Telegram are recorded by ref", () => {
  const items: Item[] = [{ key: "u1", text: "👤 hi", userText: "hi", endsRun: false }];
  assert.deepEqual(plan(items, [], new Map([["hi", "55"]]), 20), [{ key: "u1", ref: "55" }]);
});

// ---- parseInput ----

test("parseInput", () => {
  assert.deepEqual(parseInput("fix it"), { kind: "prompt", text: "fix it", mode: "steer" });
  assert.deepEqual(parseInput("/followup then test"), { kind: "prompt", text: "then test", mode: "followUp" });
  assert.deepEqual(parseInput("/abort@psalm_bot"), { kind: "abort" });
  assert.deepEqual(parseInput("/compact keep the API"), { kind: "compact", instructions: "keep the API" });
  assert.deepEqual(parseInput("/model"), { kind: "model", query: undefined });
  assert.deepEqual(parseInput("/thinking high"), { kind: "thinking", level: "high" });
  assert.deepEqual(parseInput("/skill:x"), { kind: "unknown", text: "/skill:x" });
  assert.deepEqual(parseInput("/status"), { kind: "status" });
});

// ---- draft & helpers ----

test("draftText uses the same sections as a posted turn", () => {
  assert.equal(draftText({ text: "", thinking: true, tools: [] }), "<tg-thinking>Thinking…</tg-thinking>");
  const bash = { type: "toolCall" as const, id: "1", name: "bash", arguments: { command: "ls" } };
  const running = draftText({ text: "Let me", thinking: false, tools: [{ call: bash }] });
  assert.equal(running, "Let me\n\n<details><summary>⏳ bash `ls`</summary>\n\n_running…_\n\n</details>");
  const done = { role: "toolResult", toolCallId: "1", content: [{ type: "text" as const, text: "a.go" }] };
  const finished = draftText({ text: "Let me", thinking: false, tools: [{ call: bash, result: done }] });
  assert.equal(finished, "Let me\n\n<details><summary>✓ bash `ls`</summary>\n\n```\na.go\n```\n\n</details>");
});

test("quote keeps line breaks", () => {
  assert.equal(quote("one\ntwo\n\nthree"), "> one\\\n> two\n>\n> three");
  assert.equal(quote("single"), "> single");
});

test("code survives backticks", () => {
  assert.equal(code("a"), "`a`");
  assert.equal(code("a`b"), "``a`b``");
  assert.equal(code("`x`"), "`` `x` ``");
});

test("stripComments", () => {
  const s = stripComments('{\n  // c\n  "u": "http://x", // t\n  "s": "a \\" // b"\n}');
  assert.deepEqual(JSON.parse(s), { u: "http://x", s: 'a " // b' });
});

test("status", () => {
  const s = { model: "anthropic/claude-sonnet-4-5", thinking: "high", busy: false, tokens: 42_000, contextWindow: 200_000 };
  assert.equal(
    statusText(s),
    "**status**\n\n- model: `anthropic/claude-sonnet-4-5`\n- thinking: high\n- context: 42k (21%) of 200k\n- idle",
  );
  assert.equal(statusText({ ...s, tokens: null, busy: true }).split("\n").slice(-2).join("|"), "- context: ? of 200k|- working");
  assert.equal(statusLine(s), "_model `anthropic/claude-sonnet-4-5` · thinking high_");
});
