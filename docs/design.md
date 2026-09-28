# psalm — design

## 1. What psalm is

psalm connects running pi sessions to a chat app, starting with Telegram. When you run `/psalm` in
a pi session, the session gets its own topic in your private chat with a Telegram bot. There you
can read the conversation, watch replies stream in live, and send prompts and commands back.

psalm has two parts: the **broker**, a Go program you start by hand, which talks to Telegram, and
the **extension**, a TypeScript extension loaded by pi, which talks to the broker.

## 2. Goals and rules

1. **Easy to read and maintain.** About 500 lines of Go and 350 of TypeScript.
2. **Data-oriented.** Plain data types are defined up front. All state lives in one place per
   program. Data flows through a visible pipeline of small functions; most of them are pure, and
   side effects happen only at the edges.
3. **No dependencies.** Go standard library and Node built-ins only (pi's types are type-only).
4. **Topics are append-only.** Nothing posted is edited or deleted. Only the *draft* (Telegram's
   temporary preview of a message being written) changes in place.
5. **Follow pi's concepts.** Each Telegram message is a pi thing: a user message, a turn, a compaction.
6. **Keep little state.** The broker saves only what it can't get back; the extension saves nothing.
7. **Out of scope for now:** images and voice, group chats, several users, extension dialogs.

## 3. How the parts fit together

```
 pi session ── extension ──┐
 pi session ── extension ──┼── TCP 127.0.0.1:7433 ──▶ broker ──▶ Telegram Bot API
 pi session ── extension ──┘     (one JSON object per line)
```

- **The extension knows pi, and nothing about Telegram.** It turns session entries into Markdown,
  decides what to post and when, and runs commands.
- **The broker knows Telegram, and nothing about pi.** It creates topics, posts the Markdown it is
  given, shows drafts, and forwards what you type. It never looks inside the text.

## 4. Vocabulary

| Term | Meaning |
|---|---|
| entry | One record in a pi session file. Each has an `id` and a `parentId`, so entries form a tree. |
| branch | The path from the tree's root to the current position: the conversation pi is continuing. |
| turn | pi's unit of agent work: one assistant message plus the results of its tool calls. pi fires `turn_end` when a turn finishes. |
| item | What psalm posts as one Telegram message. Every item is a pi concept (§6). |
| key | The id of the entry an item comes from. For a turn, it is the assistant message's entry id. |
| posted | The broker's ordered list of `[key, messageId]` for one topic. Its last key is called `last`. |

## 5. Protocol

Each pi session has one TCP connection. Each frame is a JSON object with a type field `t`.

```jsonc
// extension → broker
{"t":"hello", "token":"…", "session":"<pi session id>", "name":"refactor auth"}
{"t":"post",  "key":"a1b2c3d4", "text":"markdown…", "notify":true}
{"t":"post",  "text":"🌿 Branched from here", "replyTo":"a1b2c3d4"}
{"t":"post",  "key":"e5f6a7b8", "ref":"1234"}
{"t":"draft", "text":"markdown…"}
{"t":"name",  "name":"new session name"}
// broker → extension
{"t":"welcome", "posted":["a1b2c3d4", "e5f6a7b8"]}    // keys in the topic, oldest first
{"t":"input",   "text":"/model sonnet", "ref":"1234"}  // something you sent in the topic
```

| Frame | What the broker does |
|---|---|
| `hello` | Checks the token. Creates the topic, or renames it to `name` if it already exists. Posts `⏎ attached` and replies `welcome`. Closes any older connection for the same session. |
| `post` + `text` | Posts the message, silently unless `notify` is set. If a `key` is given, appends `[key, messageId]` to `posted`. `replyTo` names a key, which the broker turns into a message id. |
| `post` + `ref` | Posts nothing and appends `[key, ref]` to `posted`. Used for messages you typed in Telegram, which already exist there. |
| `draft` / `name` | Updates the live preview / renames the topic. |
| connection closed | Posts `⏏ detached`. |

## 6. What gets posted

| pi entry | Posted as |
|---|---|
| user message typed in pi | `👤`, then the text as a quote (line breaks kept) |
| user message typed in Telegram | nothing new; recorded with `ref` (§7.5) |
| turn | the assistant's text, then one line per tool call (below) |
| `compaction` / `branch_summary` | `🗜 Compacted` / `🧾 Branch summary`, followed by pi's summary |
| `model_change` / `thinking_level_change` | `model → openai/gpt-4o` / `thinking → high` |
| anything else | skipped; thinking content is never posted |

A turn looks like this (each `▸` line is a collapsed section holding that call's output):
```
Let me run the tests.

▸ ✗ bash `npm test`
▸ ✓ read `src/auth.ts`
▸ ⊘ edit `src/auth.ts`
```

- **Status marks.** `✓` and `✗` come from each tool result's `isError`. `⊘` marks a call with no
  result, which happens when a turn is aborted and pi skips the remaining calls.
- **Arguments.** The first of `command`, `path`, `file_path`, `pattern`, `url`, `query`; `code()` quotes it.
- **Length.** Text is cut at about 30000 characters (Telegram allows 32768).
- **Tool-only turns.** `"toolOnlyTurns": false` skips turns without text; their tools stay in the draft.
- **Tool output.** Every call is a collapsible `<details>` section with `✓ …` as its summary. Its
  body is an edit's diff or the result text, cut to ~3000 characters (shell keeps the tail), or a
  note: `read` → _contents not shown_ (like pi), `⊘` → _not run_. `"toolDetails"`: `"collapsed"`
  (default), `"expanded"`, or `"off"` (a compact list of lines).

## 7. The extension

### 7.1 Data

```ts
type Item = {             // one future Telegram message, derived from the branch
  key: string;            // entry id (for a turn: the assistant message's entry id)
  text: string;           // Markdown, as in §6
  userText?: string;      // raw text of a user message, for matching Telegram refs
  endsRun: boolean;       // a turn with no tool calls, or one that errored or was aborted
};
type Post = { key?: string; text?: string; ref?: string; replyTo?: string; notify?: boolean };
type Command =
  | { kind: "prompt"; text: string; mode: "steer" | "followUp" }
  | { kind: "abort" } | { kind: "compact"; instructions?: string } | { kind: "name"; name: string }
  | { kind: "model"; query?: string } | { kind: "thinking"; level?: string }
  | { kind: "unknown"; text: string };

type Store = {                        // ALL extension state, in one object on globalThis
  attached: boolean;                  // survives /new, /resume and /fork
  socket: Socket | null;
  ready: boolean;                     // welcome received on the current socket
  posted: string[];                   // copy of the broker's keys: set by welcome, appended on post
  refs: Map<string, string>;          // text sent from Telegram → its Telegram message id
  live: { text: string; thinking: boolean; tools: ToolRun[] };  // the turn in progress (drafts)
  draft: { sentAt: number; timer: Timeout | null };
  retry: Timeout | null;              // reconnect timer
  offlineNotified: boolean;
};
```

### 7.2 Pipelines

```
branch entries ─ toItems(entries, endedTurnId) ─▶ Item[] ─ plan(items, posted, refs, replay) ─▶ Post[] ─ send
input frame    ─ parseInput(text) ─▶ Command ─ run(command, ctx) ─▶ pi API
stream events  ─ draftText(store.live) ─▶ string ─ throttle (1/s) ─ send
```

`toItems`, `plan`, `parseInput` and `draftText` are pure functions and live in `model.ts`, where
they are unit-tested. `index.ts` contains only the wiring: it reads pi events, calls the pure
functions, updates the `Store`, and performs the side effects (socket writes, pi API calls).

### 7.3 Connecting

- **Commands.** `/psalm` attaches the session, `/psalm off` detaches it, and `/psalm status`
  shows the state. While attached, pi's footer shows an indicator.
- **Surviving session switches.** pi replaces the extension runtime on `/new`, `/resume` and
  `/fork`, but the `Store` lives on `globalThis` and survives. `session_shutdown` closes the
  socket; `session_start` reconnects if `attached` is set.
- **Topics.** Topics are keyed by session id, so `/new` and `/fork` get a new topic and `/resume`
  returns to the old one. A topic is named after the session, or
  `<folder> · <first 8 chars of the id>`. `session_info_changed` sends a `name` frame.
  Ephemeral (`--no-session`) sessions work too; their topic is simply never reattached.
- **Broker unreachable.** The extension retries every 3 s, shows `psalm: offline` in the footer,
  and notifies you once.

### 7.4 From branch to posts

**When is a turn finished?** `toItems` includes a turn only once it is finished, so its marks are
final. A turn is finished when any of these holds:

1. something comes after it on the branch;
2. every tool call in it has a result (a turn without tool calls is finished at once);
3. it is `endedTurnId`, which pi's `turn_end` passes in. This covers aborts, where skipped calls
   never get results.

If pi is killed mid-turn, that turn is posted once anything follows it.

**`plan`** compares the items with what the topic already has:

```ts
function plan(items: Item[], posted: string[], refs: Map<string, string>, replay: number): Post[] {
  const start = items.findLastIndex(i => posted.includes(i.key));
  const anchor = start >= 0 ? items[start].key : null;  // newest item on the branch AND in the topic
  items = items.slice(start + 1);        // only later items are new; older ones are skipped history
  const out: Post[] = [];
  if (items.length === 0) return out;
  if (anchor !== (posted.at(-1) ?? null))                 // the branch left the topic's end: a fork
    out.push(anchor ? { text: "🌿 Branched from here", replyTo: anchor }
                    : { text: "🌿 Branched from an earlier point" });
  if (anchor === null && replay >= 0 && items.length > replay) {  // nothing shared: limit history
    out.push({ text: `… ${items.length - replay} earlier messages not shown` });
    items = items.slice(-replay);
  }
  for (const item of items) {
    const ref = item.userText !== undefined ? refs.get(item.userText) : undefined;
    out.push(ref ? { key: item.key, ref } : { key: item.key, text: item.text });
  }
  const final = out.at(-1);                                      // one buzz per answer
  if (final?.text && items.find(i => i.key === final.key)?.endsRun) final.notify = true;
  return out;
}
```

`sync(endedTurnId?)` is the only caller. It sends each post from
`plan(toItems(branch, endedTurnId), store.posted, store.refs, replay)` and appends keyed posts to
`store.posted`. It is synchronous, so two syncs can never overlap.

| Trigger | Call |
|---|---|
| `welcome` | `sync()` on every (re)attach, then a note: _model `…` · thinking …_ |
| `message_end` | `setTimeout(sync, 0)`, because pi runs handlers before it saves the entry |
| `turn_end` | `sync(event.messageEntryId)` |
| `session_tree`, `session_compact` | `sync()` |

**Example: `/tree`.** The topic shows `U1 A1 U2 A2`. In pi you go back to `A1` and ask something
else, so the branch is now `U1 A1 U3`:
```
U1, A1  already posted → anchor = A1
U3      new; anchor (A1) ≠ last (A2) → "🌿 Branched from here" replying to A1, then U3
```
The topic now reads `U1 A1 U2 A2 🌿(↩A1) U3`, with nothing edited. If pi wrote a branch summary,
it is the next entry on the new branch and is posted like any other item.

The same loop handles live posting (no marker), first-attach replay, and catch-up.

### 7.5 Input from Telegram

`parseInput` turns text into a `Command`. Text without a leading `/` becomes a prompt. `run`
checks `ctx.isIdle()`:
- if pi is idle, the text is sent as a normal prompt;
- if pi is busy, it is sent with `deliverAs: "steer"`, as pi itself does.

`run` also stores `text → ref` in `store.refs`, so `plan` records the resulting user entry with
`ref` instead of posting it again. Matching is by exact text. If an input hook rewrites the text,
the message is simply posted as `👤 …`.

| Input | Command | Action |
|---|---|---|
| `/followup <text>` | prompt, `followUp` | `deliverAs: "followUp"` when busy |
| `/abort` | abort | `ctx.abort()` |
| `/compact [instructions]` | compact | `ctx.compact({ customInstructions })` |
| `/name <name>` | name | `pi.setSessionName(name)` |
| `/model [query]` | model | no query: list the models. Otherwise pick the model in `ctx.modelRegistry` whose name contains the query, then `pi.setModel` |
| `/thinking [level]` | thinking | no level: show the current one. Otherwise `pi.setThinkingLevel(level)` |
| `/status` | status | model, thinking level, context usage (`ctx.getContextUsage()`), idle/working |
| other `/…` | unknown | reply "unknown command"; custom slash commands aren't supported yet |

Replies (model lists, errors) are posted without a key. The effects of a command reach the topic
through `sync`, because pi records them as entries.

### 7.6 Drafts

While pi works, `draftText` builds the draft: the assistant text so far plus the tool calls, rendered
like the posted turn (`⏳` and _running…_ until a call finishes), or `<tg-thinking>` while thinking.

It is sent at most once per second (last ~30000 characters only). Telegram removes the draft
when a real message is posted, or after about 30 s (e.g. after an abort with no text).

## 8. The broker

### 8.1 Data

```go
// Persisted: the only data written to disk (~/.config/psalm/state.json).
type State struct {
    Sessions map[string]*Session `json:"sessions"` // by pi session id
}
type Session struct {
    Topic  string      `json:"topic"`
    Posted [][2]string `json:"posted"` // [key, messageID], oldest first; messageID "" if rejected
}

// Everything that can happen, as data. Exactly one field is set.
type Event struct {
    Frame  *Frame // a line from an extension (Conn says which)
    Closed bool   // Conn disconnected
    Input  *Input // you sent something in a topic
    Conn   *Conn
}
type Frame struct {
    T, Token, Session, Name, Key, Text, Ref, ReplyTo string
    Notify bool
}
type Input struct{ Topic, Text, Ref string }

// All broker state, owned by one goroutine.
type Broker struct {
    state  State
    conns  map[string]*Conn   // session id → live connection
    drafts map[string]string  // session id → newest unsent draft (overwritten, never queued)
    events chan Event
    ep     Endpoint
}
```

### 8.2 Pipeline

```
socket readers ──┐                     ┌─▶ Endpoint calls (Telegram, paced)
                 ├─▶ events ─▶ apply ──┼─▶ writes to connections (welcome, input)
Telegram poller ─┘   (chan)            └─▶ save state.json
```

- **Producers** (one goroutine per socket, one for Telegram polling) only parse data into `Event`s.
  They never touch state.
- **Consumer.** One goroutine runs `apply(event)`, the only code that reads or changes `Broker`. It
  handles the events from §5 and, when the queue is empty, sends one pending draft. Drafts are
  data that later ones overwrite, so they are coalesced for free.
- **Pacing.** Because Endpoint calls happen only on this goroutine, they are naturally one at a
  time. The Telegram endpoint keeps them at least `interval` apart.

```go
type Endpoint interface {
    CreateTopic(name string) (topic string, err error)
    RenameTopic(topic, name string) error
    Post(topic, markdown, replyTo string, notify bool) (msgID string, err error)
    Draft(topic, markdown string) error
    Poll(ctx context.Context, out chan<- Event) error // producer: your messages → Input events
}
```

### 8.3 Telegram specifics

- **Startup.** `getMe` must report `has_topics_enabled` (threaded mode, enabled in BotFather).
  The command menu is registered with `setMyCommands`. Only `telegram.owner` is served; that user
  id is also the chat id. If `owner` is unset, the broker logs `message from user <id>: set
  telegram.owner`.
- **Messages.**
  - Sent with `sendRichMessage`, `rich_message: {markdown}` and `disable_notification: !notify`.
  - Rich Markdown is GitHub-flavored, so there is no converter.
  - If Telegram rejects a message, it is resent as plain `sendMessage`, cut to 4096 characters.
- **Drafts.**
  - Sent with `sendRichMessageDraft`, with `draft_id` = topic id and `can_stop: true`.
  - The stop button produces `Input{Text: "/abort"}`.
- **Your messages.**
  - Non-text messages get "only text is supported".
  - Edits are ignored, and replies count as plain prompts.
  - `apply` replies "session not attached" for detached topics, and lists the sessions in
    General.
- **Pacing.**
  - On `429`, the broker sleeps for `retry_after` and retries.
  - Per-chat limits, shared by all topics, are about 1 message/s and 20 drafts per 5 s, so one
    call per second fits both.
- **Errors.**
  - A message rejected for good is recorded with an empty message id, so it isn't retried
    forever. A fork marker that points at it is posted without a reply.
  - If a topic has been deleted, `apply` drops that session and closes its connection; the
    extension then reconnects into a fresh topic.

**Persistence.** `state.json` is rewritten whole after each change, via a temporary file and a
rename. The update offset, session names and `last` are deliberately not saved: Telegram remembers
confirmed updates, names arrive with `hello`, and `last` is derived from `posted`.

## 9. Setup

1. Create a bot with BotFather and enable threaded mode.
2. Write `~/.config/psalm/config.json`:
   ```jsonc
   {
     "listen": "127.0.0.1:7433",
     "interval": "1s",                                        // minimum gap between Bot API calls
     "replay": 20,                                            // items replayed on first attach
     "toolOnlyTurns": true, "toolDetails": "collapsed",        // turns without text; output
     "telegram": { "token": "123:ABC…", "owner": 123456789 }
   }
   ```
3. Run `psalm` (or `-config <path>`); on first start it writes `~/.config/psalm/token` (0600).
4. Add the extension to pi's `settings.json`: `{ "extensions": ["F:/workspace/dan/psalm/extension"] }`.
5. Run `/psalm` in pi.

`PSALM_TELEGRAM_TOKEN` overrides the bot token, and `PSALM_ADDR` overrides the broker address. For
pi on another machine, use `ssh -R 7433:127.0.0.1:7433 host` and copy the token file.

## 10. Layout, tests, build order

| File | Contents |
|---|---|
| `types.go` | every broker data type (§8.1) and the `Endpoint` interface |
| `broker.go` | the `events` loop and `apply`, the only code that touches `Broker` |
| `pi.go` | listener and socket readers (producers) |
| `telegram.go` | the Telegram `Endpoint`: API calls, pacing, polling (producer) |
| `state.go`, `main.go` | load and save `state.json`; config and wiring |
| `extension/model.ts` | the extension's data types (§7.1) and pure functions |
| `extension/index.ts` | the `Store`, pi events and side effects |

**Tests.**
- `node --test extension/`: `model.test.ts` covers `plan` (live, replay, catch-up, `/tree`,
  abort), `toItems` and `parseInput` on plain arrays.
- `go test`: `apply` against a fake `Endpoint`; `telegram.go` against an `httptest` Bot API.
  Real Telegram is tested by hand.

**Build order.**
1. Broker types, `apply`, and the Telegram endpoint for topics and `post`; smoke-test against the
   real bot.
2. `model.ts` with its tests, then the extension's connect/`welcome`/`sync`.
3. Drafts, then Telegram input and commands, then notifications and edge cases.

## 11. Decisions and why

- **TCP and a token file, not a Unix socket.** On Windows, Node treats socket paths as named
  pipes, and Go's standard library can't serve named pipes (tested on this machine).
- **One message per finished turn.** The ✓/✗/⊘ marks stay in the topic, and an aborted or crashed
  turn never blocks later messages.
- **One goroutine owns all broker state.** No locks, and every state change can be found in `apply`.
