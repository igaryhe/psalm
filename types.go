// Every data type of the broker lives in this file. See docs/design.md §8.1.
package main

import (
	"context"
	"errors"
	"io"
	"time"
)

// ---- Configuration (read once at startup) ----

type Config struct {
	Listen      string        `json:"listen"`   // e.g. "127.0.0.1:7433"
	Interval    time.Duration `json:"-"`        // minimum gap between Bot API calls
	RawInterval string        `json:"interval"` // "1s", parsed into Interval
	Telegram    struct {
		Token string `json:"token"`
		Owner int64  `json:"owner"` // your Telegram user id; also the chat id
	} `json:"telegram"`
}

// ---- Persisted state: the only data written to disk (state.json) ----

type State struct {
	Sessions map[string]*Session `json:"sessions"` // by pi session id
}

type Session struct {
	Topic  string      `json:"topic"`
	Posted [][2]string `json:"posted"` // [key, messageID], oldest first; messageID "" if rejected
}

// ---- Events: everything that can happen, as data ----

// Event is produced by socket readers and the endpoint poller, and consumed by Broker.apply.
// Exactly one of Frame, Closed and Input is set.
type Event struct {
	Conn   *Conn  // which connection a Frame or Closed belongs to
	Frame  *Frame // a line from an extension
	Closed bool   // Conn disconnected
	Input  *Input // you sent something in a topic
}

// Frame is one line of the protocol, in either direction (docs/design.md §5).
type Frame struct {
	T       string   `json:"t"`
	Token   string   `json:"token,omitempty"`
	Session string   `json:"session,omitempty"`
	Name    string   `json:"name,omitempty"`
	Key     string   `json:"key,omitempty"`
	Text    string   `json:"text,omitempty"`
	Ref     string   `json:"ref,omitempty"`
	ReplyTo string   `json:"replyTo,omitempty"`
	Notify  bool     `json:"notify,omitempty"`
	Posted  []string `json:"posted,omitempty"`
}

// Input is a message you sent in the chat. Topic "" means outside any topic (General).
type Input struct {
	Topic   string
	Text    string
	Ref     string // the message's id on the endpoint
	NonText bool   // a photo, voice message, file, …; not supported yet
}

// ---- Live state: owned by the single goroutine running Broker.Run ----

type Broker struct {
	state     State
	statePath string
	token     string            // the shared secret extensions must present
	conns     map[string]*Conn  // pi session id → live connection
	drafts    map[string]string // pi session id → newest unsent draft (overwritten, never queued)
	events    chan Event
	ep        Endpoint
}

// Conn is one extension connection. Session and Name are set by apply on hello.
type Conn struct {
	ID      int
	Session string
	Name    string
	w       io.WriteCloser
}

// ---- The chat platform, behind a small interface ----

type Endpoint interface {
	CreateTopic(name string) (topic string, err error)
	RenameTopic(topic, name string) error
	// Post returns the new message id. replyTo is a message id or "". topic "" is General.
	Post(topic, markdown, replyTo string, notify bool) (msgID string, err error)
	Draft(topic, markdown string) error
	// Poll turns your messages into Input events until ctx is done.
	Poll(ctx context.Context, out chan<- Event) error
}

// ErrTopicGone means the topic no longer exists (you deleted it).
var ErrTopicGone = errors.New("topic gone")
