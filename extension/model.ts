// The extension's data types and pure functions. No I/O here; see index.ts for the wiring.
// See docs/design.md §7.

// ---- pi's data, as far as psalm reads it (docs: session-format.md, message-types.md) ----

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image" };

export type Message = {
  role: string; // "user" | "assistant" | "toolResult" | …
  content?: string | Block[];
  stopReason?: string; // assistant: "stop" | "toolUse" | "error" | "aborted" | …
  errorMessage?: string;
  toolCallId?: string; // toolResult
  isError?: boolean; // toolResult
  details?: { patch?: string }; // toolResult of pi's edit tool: a unified patch
};

export type Entry = {
  type: string; // "message" | "compaction" | "branch_summary" | "model_change" | …
  id: string;
  message?: Message;
  summary?: string; // compaction, branch_summary
  provider?: string; // model_change
  modelId?: string; // model_change
  thinkingLevel?: string; // thinking_level_change
};

// ---- psalm's data ----

/** One future Telegram message, derived from the branch. */
export type Item = {
  key: string; // entry id; for a turn, the assistant message's entry id
  text: string; // Markdown
  userText?: string; // raw text of a user message, for matching Telegram refs
  endsRun: boolean; // a turn with no tool calls, or one that errored or was aborted
};

/** How items are rendered; set in config.json. */
export type Render = {
  toolOnlyTurns: boolean; // post turns that have no text
  toolDetails: "collapsed" | "expanded" | "off"; // each tool call's output (or diff) under its line
};
export const defaultRender: Render = { toolOnlyTurns: true, toolDetails: "collapsed" };

/** What the extension asks the broker to post (a `post` frame without `t`). */
export type Post = { key?: string; text?: string; ref?: string; replyTo?: string; notify?: boolean };

/** A message you sent in the topic, parsed. */
export type Command =
  | { kind: "prompt"; text: string; mode: "steer" | "followUp" }
  | { kind: "abort" }
  | { kind: "compact"; instructions?: string }
  | { kind: "name"; name: string }
  | { kind: "model"; query?: string }
  | { kind: "thinking"; level?: string }
  | { kind: "status" }
  | { kind: "unknown"; text: string };

/** The session's current settings, for /status and the note posted on attach. */
export type Status = {
  model?: string; // "provider/id"
  thinking: string;
  busy: boolean;
  tokens?: number | null; // context tokens in use; null right after compaction
  contextWindow?: number;
};

/** A tool call in the current turn, as shown in the draft; `result` is set once it finishes. */
export type ToolRun = { call: ToolCall; result?: Message };

/** What the draft shows: the turn in progress. */
export type Live = { text: string; thinking: boolean; tools: ToolRun[] };

/** ALL extension state. One object, kept on globalThis so it survives session switches. */
export type Store = {
  attached: boolean; // set by /psalm, cleared by /psalm off
  socket: import("node:net").Socket | null;
  ready: boolean; // welcome received on the current socket
  posted: string[]; // copy of the broker's keys: set by welcome, appended on post
  refs: Map<string, string>; // text sent from Telegram → its Telegram message id
  live: Live;
  draft: { sentAt: number; timer: ReturnType<typeof setTimeout> | null };
  retry: ReturnType<typeof setTimeout> | null; // reconnect timer
  offlineNotified: boolean;
};

export const MAX_TEXT = 30000;
export const MAX_BODY = 3000; // characters of output per tool call; cut at a line boundary
export const SHELL_TOOLS = ["bash", "powershell"]; // their output keeps its tail, as in pi
export const NO_OUTPUT_TOOLS = ["read"]; // like pi's terminal, show the call but not the file contents
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ---- branch entries → items ----

/**
 * Turns the branch into items, oldest first. Stops before an unfinished turn (§7.4): a turn is
 * finished if something follows it, all its tool calls have results, or it is `endedTurnId`.
 * `render` decides whether tool-only turns are posted and how edit diffs are shown.
 */
export function toItems(entries: Entry[], endedTurnId?: string, render: Render = defaultRender): Item[] {
  const results = new Map<string, Message>(); // toolCallId → isError
  for (const e of entries) {
    if (e.message?.role === "toolResult" && e.message.toolCallId) results.set(e.message.toolCallId, e.message);
  }
  const items: Item[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const m = e.message;
    if (e.type === "message" && m?.role === "assistant") {
      const calls = blocks(m).filter((b) => b.type === "toolCall");
      let end = i + 1; // skip this turn's tool results
      while (end < entries.length && entries[end].message?.role === "toolResult") end++;
      const finished = end < entries.length || calls.every((c) => results.has(c.id)) || e.id === endedTurnId;
      if (!finished) break;
      const item = turnItem(e.id, m, calls, results, render);
      if (item) items.push(item);
    } else {
      const item = otherItem(e);
      if (item) items.push(item);
    }
  }
  return items;
}

export type ToolCall = Extract<Block, { type: "toolCall" }>;

// A call without a result is "not run" in a posted turn, and still "running" in the draft.
type Missing = "notRun" | "running";

function turnItem(
  key: string,
  m: Message,
  calls: ToolCall[],
  results: Map<string, Message>,
  render: Render,
): Item | null {
  const text = blocks(m).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
  const status =
    m.stopReason === "error" ? `⚠️ ${m.errorMessage ?? "error"}` : m.stopReason === "aborted" ? "⚠️ aborted" : "";
  if (!text && !status && !render.toolOnlyTurns) return null; // a tool-only turn, and they are hidden
  const budget = MAX_TEXT - text.length - status.length - 100;
  const parts = [text, toolsMarkdown(calls, results, render.toolDetails, budget), status].filter(Boolean);
  if (parts.length === 0) return null;
  const endsRun = calls.length === 0 || m.stopReason === "error" || m.stopReason === "aborted";
  return { key, text: cut(parts.join("\n\n")), endsRun };
}

/**
 * A turn's tool calls, one collapsible section each: the `✓ …` line as its summary and the call's
 * output (or a short note) as its body. With `mode` "off", just a list of lines.
 */
function toolsMarkdown(
  calls: ToolCall[],
  results: Map<string, Message>,
  mode: Render["toolDetails"],
  budget: number,
  missing: Missing = "notRun",
): string {
  if (mode === "off") return list(calls.map((c) => toolLine(c, results.get(c.id), missing)));
  let used = 0;
  return calls
    .map((call) => {
      const result = results.get(call.id);
      const line = toolLine(call, result, missing);
      let body = toolBody(call, result, missing);
      if (used + body.length > budget) body = "_output omitted: message too long_";
      used += body.length + line.length + 40;
      return mode === "expanded" ? `${line}\n\n${body}` : `<details><summary>${line}</summary>\n\n${body}\n\n</details>`;
    })
    .join("\n\n");
}

/** `✓ bash \`npm test\``: the call's outcome and label. */
function toolLine(call: ToolCall, result: Message | undefined, missing: Missing): string {
  const mark = !result ? (missing === "running" ? "⏳" : "⊘") : result.isError ? "✗" : "✓";
  return `${mark} ${toolLabel(call.name, call.arguments)}`;
}

/** What a call produced: an edit's diff, the result text the model saw, or a short note. */
function toolBody(call: ToolCall, result: Message | undefined, missing: Missing): string {
  if (!result) return missing === "running" ? "_running…_" : "_not run_";
  if (!result.isError && NO_OUTPUT_TOOLS.includes(call.name)) return "_contents not shown_"; // errors always show
  const patch = result.isError ? undefined : result.details?.patch?.trim();
  if (patch) return fenced("diff", cutLines(patch, MAX_BODY));
  const output = messageText(result);
  return output ? fenced("", cutLines(output, MAX_BODY, SHELL_TOOLS.includes(call.name))) : "_no output_";
}

function otherItem(e: Entry): Item | null {
  const item = (text: string, userText?: string): Item => ({ key: e.id, text: cut(text), userText, endsRun: false });
  switch (e.type) {
    case "message": {
      if (e.message?.role !== "user") return null;
      const text = messageText(e.message);
      return text ? item(`👤\n\n${quote(text)}`, text) : null;
    }
    case "compaction":
      return item(`🗜 **Compacted**\n\n${e.summary ?? ""}`);
    case "branch_summary":
      return item(`🧾 **Branch summary**\n\n${e.summary ?? ""}`);
    case "model_change":
      return item(`_model → ${e.provider}/${e.modelId}_`);
    case "thinking_level_change":
      return item(`_thinking → ${e.thinkingLevel}_`);
    default:
      return null;
  }
}

/** `bash \`npm test\``: the tool name plus its most telling argument. */
export function toolLabel(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const k of ["command", "path", "file_path", "pattern", "url", "query"]) {
    if (typeof a[k] === "string") return `${name} ${code(oneLine(a[k] as string))}`;
  }
  return name;
}

/**
 * A Markdown list: one line per entry. Telegram's rich Markdown is GitHub-flavored, where a single
 * newline is a soft break, so plain "\n"-joined lines would render as one paragraph.
 */
export function list(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * A Markdown quote that keeps its line breaks: a single newline would merge lines, so each line
 * followed by another gets a hard break (a trailing backslash). Blank lines stay paragraph breaks.
 */
export function quote(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((l, i) => (l.trim() ? `> ${l}${lines[i + 1]?.trim() ? "\\" : ""}` : ">"))
    .join("\n");
}

/** A fenced code block whose fence is longer than any backtick run inside the text. */
export function fenced(lang: string, s: string): string {
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${s}\n${fence}`;
}

/**
 * Cuts s to at most max characters at line boundaries, keeping the head (or the tail, for shell
 * output) and noting how many lines were dropped.
 */
export function cutLines(s: string, max: number, keepTail = false): string {
  if (s.length <= max) return s;
  const lines = s.split("\n");
  if (keepTail) lines.reverse();
  const kept: string[] = [];
  for (let size = 0; kept.length < lines.length && size + lines[kept.length].length + 1 <= max; ) {
    size += lines[kept.length].length + 1;
    kept.push(lines[kept.length]);
  }
  if (kept.length === 0) kept.push(keepTail ? "…" + lines[0].slice(-max) : lines[0].slice(0, max) + "…");
  const dropped = lines.length - kept.length;
  return keepTail
    ? [`… (${dropped} earlier lines)`, ...kept.reverse()].join("\n")
    : [...kept, `… (${dropped} more lines)`].join("\n");
}
/** Inline code that survives backticks inside the value. */
export function code(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

// ---- items → posts ----

/** Compares the branch's items with what the topic has, and returns what to post (§7.4). */
export function plan(items: Item[], posted: string[], refs: Map<string, string>, replay: number): Post[] {
  // The anchor is the newest item that is both on the branch and in the topic. Only items after
  // it are new; older unposted items are history that the replay limit skipped.
  const start = items.findLastIndex((i) => posted.includes(i.key));
  const anchor = start >= 0 ? items[start].key : null;
  items = items.slice(start + 1);
  const out: Post[] = [];
  if (items.length === 0) return out;
  if (anchor !== (posted.at(-1) ?? null)) {
    // The branch left the topic's end: a fork (or, with no anchor, from before anything shown).
    out.push(anchor ? { text: "🌿 Branched from here", replyTo: anchor } : { text: "🌿 Branched from an earlier point" });
  }
  if (anchor === null && replay >= 0 && items.length > replay) {
    out.push({ text: `… ${items.length - replay} earlier messages not shown` });
    items = items.slice(items.length - replay);
  }
  for (const item of items) {
    const ref = item.userText !== undefined ? refs.get(item.userText) : undefined;
    out.push(ref ? { key: item.key, ref } : { key: item.key, text: item.text });
  }
  const final = out.at(-1);
  if (final?.text && items.find((i) => i.key === final.key)?.endsRun) final.notify = true;
  return out;
}

// ---- your messages → commands ----

export function parseInput(text: string): Command {
  text = text.trim();
  if (!text.startsWith("/")) return { kind: "prompt", text, mode: "steer" };
  const space = text.search(/\s/);
  const name = (space < 0 ? text : text.slice(0, space)).replace(/@\S*$/, "").toLowerCase();
  const arg = space < 0 ? "" : text.slice(space).trim();
  switch (name) {
    case "/followup":
      return arg ? { kind: "prompt", text: arg, mode: "followUp" } : { kind: "unknown", text };
    case "/abort":
      return { kind: "abort" };
    case "/compact":
      return { kind: "compact", instructions: arg || undefined };
    case "/name":
      return arg ? { kind: "name", name: arg } : { kind: "unknown", text };
    case "/model":
      return { kind: "model", query: arg || undefined };
    case "/status":
      return { kind: "status" };
    case "/thinking":
      return { kind: "thinking", level: arg || undefined };
    default:
      return { kind: "unknown", text };
  }
}

// ---- the turn in progress → draft ----

export function draftText(live: Live, mode: Render["toolDetails"] = defaultRender.toolDetails): string {
  let text = live.text.trim();
  if (text.length > MAX_TEXT / 2) text = "…" + text.slice(text.length - MAX_TEXT / 2); // keep the tail
  const results = new Map(live.tools.filter((t) => t.result).map((t) => [t.call.id, t.result!] as const));
  const calls = live.tools.map((t) => t.call);
  const tools = toolsMarkdown(calls, results, mode, MAX_TEXT - text.length - 100, "running");
  const out = [text, tools].filter(Boolean).join("\n\n");
  return out || (live.thinking ? "<tg-thinking>Thinking…</tg-thinking>" : "");
}
// ---- status ----

/** The full status, answering /status. */
export function statusText(s: Status): string {
  const lines = [`model: \`${s.model ?? "none"}\``, `thinking: ${s.thinking}`];
  if (s.contextWindow) {
    const used = s.tokens == null ? "?" : `${kilo(s.tokens)} (${Math.round((s.tokens / s.contextWindow) * 100)}%)`;
    lines.push(`context: ${used} of ${kilo(s.contextWindow)}`);
  }
  lines.push(s.busy ? "working" : "idle");
  return `**status**\n\n${list(lines)}`;
}

/** One line, posted on attach: the settings the next answers will use. */
export function statusLine(s: Status): string {
  return `_model \`${s.model ?? "none"}\` \u00b7 thinking ${s.thinking}_`;
}

function kilo(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ---- small helpers ----

export function blocks(m: Message): Block[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
}

export function messageText(m: Message): string {
  return blocks(m)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function cut(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n\n… (truncated)" : s;
}

/** Removes // comments outside strings, so config.json may be annotated. */
export function stripComments(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += s[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return out;
}
