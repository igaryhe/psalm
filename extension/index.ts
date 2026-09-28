// psalm pi extension: wiring and side effects. Data types and pure logic live in model.ts.
// See docs/design.md §7.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type Command,
  defaultRender,
  draftText,
  type Entry,
  list,
  type Live,
  messageText,
  parseInput,
  plan,
  type Render,
  type Status,
  statusLine,
  statusText,
  type Store,
  stripComments,
  THINKING_LEVELS,
  toItems,
} from "./model.ts";

// ---- configuration (read once per runtime) ----

const dir = join(homedir(), ".config", "psalm");
const config = readConfig();

function readConfig(): { host: string; port: number; replay: number; render: Render; token: string } {
  let file: { listen?: string; replay?: number; toolOnlyTurns?: boolean; toolDetails?: string } = {};
  try {
    file = JSON.parse(stripComments(readFileSync(join(dir, "config.json"), "utf8")));
  } catch {}
  let token = "";
  try {
    token = readFileSync(join(dir, "token"), "utf8").trim();
  } catch {}
  const addr = process.env.PSALM_ADDR || file.listen || "127.0.0.1:7433";
  const colon = addr.lastIndexOf(":");
  return {
    host: addr.slice(0, colon),
    port: Number(addr.slice(colon + 1)),
    replay: file.replay ?? 20,
    render: {
      toolOnlyTurns: file.toolOnlyTurns ?? defaultRender.toolOnlyTurns,
      toolDetails:
        file.toolDetails === "expanded" || file.toolDetails === "off" ? file.toolDetails : defaultRender.toolDetails,
    },
    token,
  };
}

// ---- the store: all state, surviving runtime replacement on /new, /resume and /fork ----

const emptyLive = (): Live => ({ text: "", thinking: false, tools: [] });

const store: Store = ((globalThis as any)[Symbol.for("psalm.store")] ??= {
  attached: false,
  socket: null,
  ready: false,
  posted: [],
  refs: new Map(),
  live: emptyLive(),
  draft: { sentAt: 0, timer: null },
  retry: null,
  offlineNotified: false,
} satisfies Store);

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined; // the current runtime's context

  // ---- connection ----

  function attach() {
    if (!store.attached || store.socket || !ctx) return;
    const sock = connect(config.port, config.host);
    Object.assign(store, { socket: sock, ready: false, posted: [] });
    sock.setEncoding("utf8");
    let buffer = "";
    sock.on("connect", () => {
      store.offlineNotified = false;
      status("psalm");
      send({ t: "hello", token: config.token, session: ctx!.sessionManager.getSessionId(), name: sessionName() });
    });
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onFrame(JSON.parse(line));
      }
    });
    sock.on("error", () => {}); // "close" follows
    sock.on("close", () => {
      if (store.socket !== sock) return; // closed on purpose
      Object.assign(store, { socket: null, ready: false });
      if (!store.attached) return;
      status("psalm: offline");
      if (!store.offlineNotified) ctx?.ui.notify(`psalm: broker unreachable at ${config.host}:${config.port}`, "warning");
      store.offlineNotified = true;
      store.retry = setTimeout(attach, 3000);
    });
  }

  function detach() {
    if (store.retry) clearTimeout(store.retry);
    stopDraft();
    const sock = store.socket;
    Object.assign(store, { socket: null, ready: false, retry: null });
    sock?.destroy();
  }

  function send(frame: Record<string, unknown>) {
    store.socket?.write(JSON.stringify(frame) + "\n");
  }

  function onFrame(f: { t: string; posted?: string[]; text?: string; ref?: string }) {
    if (f.t === "welcome") {
      Object.assign(store, { ready: true, posted: f.posted ?? [] });
      sync(); // history first, then the settings the next answers will use
      if (ctx) reply(statusLine(currentStatus(ctx)));
    } else if (f.t === "input") {
      handleInput(f.text ?? "", f.ref ?? "").catch((e) => reply(`error: ${e?.message ?? e}`));
    }
  }

  // ---- branch → posts (§7.4) ----

  function sync(endedTurnId?: string) {
    if (!store.ready || !ctx) return;
    const items = toItems(ctx.sessionManager.getBranch() as Entry[], endedTurnId, config.render);
    for (const post of plan(items, store.posted, store.refs, config.replay)) {
      send({ t: "post", ...post });
      if (post.key) store.posted.push(post.key);
      if (post.ref) for (const [text, ref] of store.refs) if (ref === post.ref) store.refs.delete(text);
    }
  }

  // ---- drafts (§7.6) ----

  function scheduleDraft() {
    if (!store.ready || store.draft.timer) return;
    const delay = Math.max(0, store.draft.sentAt + 1000 - Date.now());
    store.draft.timer = setTimeout(() => {
      store.draft = { sentAt: Date.now(), timer: null };
      const text = draftText(store.live, config.render.toolDetails);
      if (text) send({ t: "draft", text });
    }, delay);
  }

  function stopDraft() {
    if (store.draft.timer) clearTimeout(store.draft.timer);
    store.draft.timer = null;
    store.live = emptyLive();
  }

  // ---- your messages (§7.5) ----

  function reply(text: string) {
    send({ t: "post", text });
  }

  async function handleInput(text: string, ref: string) {
    const c = ctx;
    if (!c) return;
    const cmd: Command = parseInput(text);
    switch (cmd.kind) {
      case "prompt": {
        store.refs.set(cmd.text, ref);
        if (c.isIdle()) pi.sendUserMessage(cmd.text);
        else pi.sendUserMessage(cmd.text, { deliverAs: cmd.mode });
        return;
      }
      case "abort":
        if (c.isIdle()) reply("nothing to abort");
        else c.abort();
        return;
      case "compact":
        reply("compacting…");
        c.compact({ customInstructions: cmd.instructions, onError: (e) => reply(`compaction failed: ${e.message}`) });
        return;
      case "name":
        pi.setSessionName(cmd.name);
        return;
      case "model":
        return model(c, cmd.query);
      case "thinking":
        if (!cmd.level) return reply(`thinking: ${pi.getThinkingLevel()}\n\nlevels: ${THINKING_LEVELS.join(", ")}`);
        if (!THINKING_LEVELS.includes(cmd.level)) return reply(`unknown level; use one of: ${THINKING_LEVELS.join(", ")}`);
        pi.setThinkingLevel(cmd.level as any);
        return;
      case "status":
        return reply(statusText(currentStatus(c)));
      case "unknown":
        return reply(`unknown command: ${cmd.text}`);
    }
  }

  async function model(c: ExtensionContext, query?: string) {
    const models = c.modelRegistry.getAvailable();
    const id = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
    const modelList = (ms: typeof models) =>
      list(ms.map((m) => `${c.model && id(m) === id(c.model) ? "•" : "◦"} \`${id(m)}\``));
    if (!query) return reply(`**models**\n\n${modelList(models)}`);
    const q = query.toLowerCase();
    const exact = models.filter((m) => id(m).toLowerCase() === q || m.id.toLowerCase() === q);
    const matches = exact.length ? exact : models.filter((m) => id(m).toLowerCase().includes(q));
    if (matches.length === 0) return reply(`no model matches "${query}"`);
    if (matches.length > 1) return reply(`several models match "${query}":\n\n${modelList(matches)}`);
    if (!(await pi.setModel(matches[0]))) reply(`no credentials for ${matches[0].provider}`);
  }

  // ---- helpers ----

  function currentStatus(c: ExtensionContext): Status {
    const usage = c.getContextUsage();
    return {
      model: c.model ? `${c.model.provider}/${c.model.id}` : undefined,
      thinking: pi.getThinkingLevel(),
      busy: !c.isIdle(),
      tokens: usage?.tokens,
      contextWindow: usage?.contextWindow,
    };
  }

  function sessionName(): string {
    const sm = ctx!.sessionManager;
    return pi.getSessionName() || `${basename(sm.getCwd())} · ${sm.getSessionId().slice(0, 8)}`;
  }

  function status(text: string | undefined) {
    ctx?.ui.setStatus("psalm", text);
  }

  // ---- pi events ----

  pi.on("session_start", (_e, c) => {
    ctx = c;
    if (store.attached) attach();
  });
  pi.on("session_shutdown", () => detach());
  pi.on("session_info_changed", () => send({ t: "name", name: sessionName() }));
  pi.on("session_tree", () => sync());
  pi.on("session_compact", () => sync());
  pi.on("message_end", () => void setTimeout(() => sync(), 0)); // pi saves the entry right after the handlers
  pi.on("turn_start", () => {
    store.live = { ...emptyLive(), thinking: true };
    scheduleDraft();
  });
  pi.on("turn_end", (e) => {
    stopDraft();
    sync(e.messageEntryId);
  });
  pi.on("agent_settled", () => stopDraft());
  pi.on("message_update", (e) => {
    if (e.message.role !== "assistant") return;
    store.live.text = messageText(e.message as any);
    store.live.thinking = e.assistantMessageEvent.type.startsWith("thinking");
    scheduleDraft();
  });
  pi.on("tool_execution_start", (e) => {
    store.live.tools.push({ call: { type: "toolCall", id: e.toolCallId, name: e.toolName, arguments: e.args ?? {} } });
    scheduleDraft();
  });
  pi.on("tool_execution_end", (e) => {
    const run = store.live.tools.find((t) => t.call.id === e.toolCallId);
    if (run) {
      const r = e.result ?? {};
      run.result = { role: "toolResult", toolCallId: e.toolCallId, isError: e.isError, content: r.content, details: r.details };
    }
    scheduleDraft();
  });

  // ---- /psalm ----

  pi.registerCommand("psalm", {
    description: "Relay this session to Telegram (/psalm, /psalm off, /psalm status)",
    handler: async (args, c) => {
      ctx = c;
      const arg = args.trim();
      if (arg === "off") {
        store.attached = false;
        detach();
        status(undefined);
        c.ui.notify("psalm: detached", "info");
      } else if (arg === "status") {
        const state = !store.attached ? "detached" : store.ready ? "attached" : "connecting";
        c.ui.notify(`psalm: ${state} (broker ${config.host}:${config.port})`, "info");
      } else {
        store.attached = true;
        attach();
        c.ui.notify("psalm: attaching", "info");
      }
    },
  });
}
