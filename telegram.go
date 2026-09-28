// The Telegram Endpoint: Bot API calls, pacing, and the update poller. See docs/design.md §8.3.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Telegram struct {
	base     string // "https://api.telegram.org/bot<token>/"
	owner    int64  // your user id, which is also the private chat id
	interval time.Duration
	lastCall time.Time // pacing; only touched by the broker goroutine
	client   *http.Client
}

func NewTelegram(token string, owner int64, interval time.Duration) *Telegram {
	return &Telegram{
		base:     "https://api.telegram.org/bot" + token + "/",
		owner:    owner,
		interval: interval,
		client:   &http.Client{Timeout: 90 * time.Second},
	}
}

// ---- Bot API data (only the fields psalm reads) ----

type apiResponse struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	ErrorCode   int             `json:"error_code"`
	Description string          `json:"description"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

type update struct {
	UpdateID int64    `json:"update_id"`
	Message  *message `json:"message"`
	Stopped  *struct {
		ThreadID int64 `json:"message_thread_id"`
	} `json:"stopped_message_generation"`
}

type message struct {
	MessageID int64  `json:"message_id"`
	ThreadID  int64  `json:"message_thread_id"`
	Text      string `json:"text"`
	From      *struct {
		ID int64 `json:"id"`
	} `json:"from"`
	// Present on media messages, which psalm doesn't support yet.
	Photo     json.RawMessage `json:"photo"`
	Voice     json.RawMessage `json:"voice"`
	Audio     json.RawMessage `json:"audio"`
	Video     json.RawMessage `json:"video"`
	VideoNote json.RawMessage `json:"video_note"`
	Document  json.RawMessage `json:"document"`
	Sticker   json.RawMessage `json:"sticker"`
	Animation json.RawMessage `json:"animation"`
}

func (m *message) isMedia() bool {
	for _, f := range []json.RawMessage{m.Photo, m.Voice, m.Audio, m.Video, m.VideoNote, m.Document, m.Sticker, m.Animation} {
		if f != nil {
			return true
		}
	}
	return false
}

// APIError is a request Telegram refused; retrying won't help.
type APIError struct {
	Code        int
	Description string
}

func (e *APIError) Error() string { return fmt.Sprintf("telegram %d: %s", e.Code, e.Description) }

// ---- Setup (called once, before the broker starts) ----

var botCommands = []map[string]string{
	{"command": "followup", "description": "queue a message until the agent is done"},
	{"command": "abort", "description": "stop the agent"},
	{"command": "compact", "description": "compact the context"},
	{"command": "name", "description": "rename the session"},
	{"command": "model", "description": "show or switch the model"},
	{"command": "thinking", "description": "show or set the thinking level"},
	{"command": "status", "description": "show the model, thinking level and context usage"},
}

func (t *Telegram) Setup() error {
	var me struct {
		Username         string `json:"username"`
		HasTopicsEnabled bool   `json:"has_topics_enabled"`
	}
	if err := t.call("getMe", map[string]any{}, &me); err != nil {
		return err
	}
	if !me.HasTopicsEnabled {
		return fmt.Errorf("@%s: enable threaded mode for the bot in BotFather", me.Username)
	}
	if t.owner == 0 {
		log.Printf("telegram.owner is not set: send any message to @%s and check this log", me.Username)
	}
	return t.call("setMyCommands", map[string]any{"commands": botCommands}, nil)
}

// ---- Endpoint ----

func (t *Telegram) CreateTopic(name string) (string, error) {
	var topic struct {
		ThreadID int64 `json:"message_thread_id"`
	}
	err := t.call("createForumTopic", map[string]any{"chat_id": t.owner, "name": topicName(name)}, &topic)
	return strconv.FormatInt(topic.ThreadID, 10), err
}

func (t *Telegram) RenameTopic(topic, name string) error {
	return t.topicErr(t.call("editForumTopic", map[string]any{
		"chat_id": t.owner, "message_thread_id": atoi(topic), "name": topicName(name),
	}, nil))
}

// Post sends rich Markdown, falling back to plain text if Telegram rejects the Markdown.
func (t *Telegram) Post(topic, markdown, replyTo string, notify bool) (string, error) {
	params := map[string]any{"chat_id": t.owner, "disable_notification": !notify}
	if topic != "" {
		params["message_thread_id"] = atoi(topic)
	}
	if replyTo != "" {
		params["reply_parameters"] = map[string]any{"message_id": atoi(replyTo), "allow_sending_without_reply": true}
	}
	var sent struct {
		MessageID int64 `json:"message_id"`
	}
	params["rich_message"] = map[string]any{"markdown": markdown}
	err := t.topicErr(t.call("sendRichMessage", params, &sent))
	if _, refused := err.(*APIError); refused {
		delete(params, "rich_message")
		params["text"] = truncate(markdown, 4096)
		err = t.topicErr(t.call("sendMessage", params, &sent))
	}
	if err != nil {
		return "", err
	}
	return strconv.FormatInt(sent.MessageID, 10), nil
}

func (t *Telegram) Draft(topic, markdown string) error {
	return t.topicErr(t.call("sendRichMessageDraft", map[string]any{
		"chat_id":           t.owner,
		"message_thread_id": atoi(topic),
		"draft_id":          atoi(topic), // one draft per topic; topic ids are non-zero
		"rich_message":      map[string]any{"markdown": markdown},
		"can_stop":          true,
	}, nil))
}

// Poll long-polls for updates and turns your messages into Input events.
func (t *Telegram) Poll(ctx context.Context, out chan<- Event) error {
	var offset int64
	for ctx.Err() == nil {
		var updates []update
		err := t.request(ctx, "getUpdates", map[string]any{
			"offset": offset, "timeout": 50,
			"allowed_updates": []string{"message", "stopped_message_generation"},
		}, &updates)
		if err != nil {
			log.Printf("getUpdates: %v", err)
			sleep(ctx, 5*time.Second)
			continue
		}
		for _, u := range updates {
			offset = u.UpdateID + 1
			if in := t.input(u); in != nil {
				out <- Event{Input: in}
			}
		}
	}
	return ctx.Err()
}

// input turns an update into an Input, or nil if psalm ignores it.
func (t *Telegram) input(u update) *Input {
	if u.Stopped != nil {
		return &Input{Topic: threadTopic(u.Stopped.ThreadID), Text: "/abort"}
	}
	m := u.Message
	if m == nil || m.From == nil {
		return nil
	}
	if m.From.ID != t.owner {
		if t.owner == 0 {
			log.Printf("message from user %d: set telegram.owner", m.From.ID)
		}
		return nil
	}
	in := &Input{Topic: threadTopic(m.ThreadID), Text: m.Text, Ref: strconv.FormatInt(m.MessageID, 10)}
	if m.Text == "" {
		if !m.isMedia() {
			return nil // a service message, e.g. "topic created"
		}
		in.NonText = true
	}
	return in
}

// ---- HTTP ----

// call is a paced Bot API request. Only the broker goroutine (and Setup, before it) uses it.
func (t *Telegram) call(method string, params, result any) error {
	if wait := time.Until(t.lastCall.Add(t.interval)); wait > 0 {
		time.Sleep(wait)
	}
	defer func() { t.lastCall = time.Now() }()
	return t.request(context.Background(), method, params, result)
}

// request sends one Bot API request. It retries network errors, 5xx and 429 (after
// retry_after), and returns *APIError for anything Telegram refuses.
func (t *Telegram) request(ctx context.Context, method string, params, result any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	for backoff := time.Second; ; backoff = min(backoff*2, 30*time.Second) {
		req, err := http.NewRequestWithContext(ctx, "POST", t.base+method, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		var r apiResponse
		resp, err := t.client.Do(req)
		if err == nil {
			err = json.NewDecoder(resp.Body).Decode(&r)
			resp.Body.Close()
		}
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case err != nil || r.ErrorCode >= 500:
			log.Printf("%s: %v %s; retrying in %s", method, err, r.Description, backoff)
			sleep(ctx, backoff)
		case r.ErrorCode == 429:
			sleep(ctx, time.Duration(r.Parameters.RetryAfter)*time.Second)
		case !r.OK:
			return &APIError{Code: r.ErrorCode, Description: r.Description}
		case result == nil:
			return nil
		default:
			return json.Unmarshal(r.Result, result)
		}
	}
}

// topicErr maps "the topic was deleted" to ErrTopicGone.
func (t *Telegram) topicErr(err error) error {
	if e, ok := err.(*APIError); ok {
		d := strings.ToLower(e.Description)
		if strings.Contains(d, "thread not found") || strings.Contains(d, "topic_deleted") {
			return ErrTopicGone
		}
	}
	return err
}

// ---- Small helpers ----

func threadTopic(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func topicName(name string) string {
	if name = strings.TrimSpace(name); name == "" {
		name = "pi"
	}
	return truncate(name, 128)
}

// truncate cuts s to at most n characters (runes).
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
