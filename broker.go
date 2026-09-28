// The event loop. apply is the only code that reads or changes Broker. See docs/design.md §8.2.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strings"
	"time"
)

func NewBroker(state State, statePath, token string, ep Endpoint) *Broker {
	if state.Sessions == nil {
		state.Sessions = map[string]*Session{}
	}
	return &Broker{
		state:     state,
		statePath: statePath,
		token:     token,
		conns:     map[string]*Conn{},
		drafts:    map[string]string{},
		events:    make(chan Event, 256),
		ep:        ep,
	}
}

// Run consumes events until ctx is done. When no event is waiting, it sends one pending draft.
func (b *Broker) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-b.events:
			b.apply(ev)
			continue
		default:
		}
		if b.flushDraft() {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case ev := <-b.events:
			b.apply(ev)
		}
	}
}

func (b *Broker) apply(ev Event) {
	switch {
	case ev.Input != nil:
		b.onInput(*ev.Input)
	case ev.Closed:
		b.onClosed(ev.Conn)
	case ev.Frame != nil:
		b.onFrame(ev.Conn, *ev.Frame)
	}
}

// ---- Frames from extensions ----

func (b *Broker) onFrame(c *Conn, f Frame) {
	if f.T == "hello" {
		b.onHello(c, f)
		return
	}
	if c.Session == "" || b.conns[c.Session] != c {
		log.Printf("conn %d: %q before hello, closing", c.ID, f.T)
		c.w.Close()
		return
	}
	s := b.state.Sessions[c.Session]
	switch f.T {
	case "post":
		b.onPost(c.Session, s, f)
	case "draft":
		b.drafts[c.Session] = f.Text
	case "name":
		c.Name = f.Name
		if err := b.ep.RenameTopic(s.Topic, f.Name); errors.Is(err, ErrTopicGone) {
			b.dropSession(c.Session)
		}
	default:
		log.Printf("conn %d: unknown frame %q", c.ID, f.T)
	}
}

func (b *Broker) onHello(c *Conn, f Frame) {
	if f.Token != b.token || f.Session == "" || c.Session != "" {
		log.Printf("conn %d: rejected hello", c.ID)
		c.w.Close()
		return
	}
	s := b.state.Sessions[f.Session]
	if s != nil {
		if err := b.ep.RenameTopic(s.Topic, f.Name); errors.Is(err, ErrTopicGone) {
			delete(b.state.Sessions, f.Session)
			s = nil
		}
	}
	if s == nil {
		topic, err := b.ep.CreateTopic(f.Name)
		if err != nil {
			log.Printf("conn %d: create topic: %v", c.ID, err)
			c.w.Close()
			return
		}
		s = &Session{Topic: topic}
		b.state.Sessions[f.Session] = s
		b.save()
	}
	if old := b.conns[f.Session]; old != nil {
		old.w.Close() // its Closed event is ignored because it is no longer in conns
	}
	c.Session, c.Name = f.Session, f.Name
	b.conns[f.Session] = c
	b.post(f.Session, "⏎ attached", "", false)
	keys := make([]string, len(s.Posted))
	for i, p := range s.Posted {
		keys[i] = p[0]
	}
	send(c, Frame{T: "welcome", Posted: keys})
}

func (b *Broker) onPost(session string, s *Session, f Frame) {
	delete(b.drafts, session) // Telegram drops the draft once a real message arrives
	if f.Ref != "" {
		s.Posted = append(s.Posted, [2]string{f.Key, f.Ref})
		b.save()
		return
	}
	msgID, ok := b.post(session, f.Text, messageID(s, f.ReplyTo), f.Notify)
	if ok && f.Key != "" {
		s.Posted = append(s.Posted, [2]string{f.Key, msgID})
		b.save()
	}
}

func (b *Broker) onClosed(c *Conn) {
	c.w.Close()
	if c.Session == "" || b.conns[c.Session] != c {
		return // never attached, or replaced by a newer connection
	}
	delete(b.conns, c.Session)
	delete(b.drafts, c.Session)
	if b.state.Sessions[c.Session] != nil {
		b.post(c.Session, "⏏ detached", "", false)
	}
}

// ---- Your messages ----

func (b *Broker) onInput(in Input) {
	if in.NonText {
		b.ep.Post(in.Topic, "only text is supported", in.Ref, false)
		return
	}
	if in.Topic == "" {
		b.ep.Post("", b.sessionList(), "", false)
		return
	}
	for id, s := range b.state.Sessions {
		if s.Topic != in.Topic {
			continue
		}
		if c := b.conns[id]; c != nil {
			send(c, Frame{T: "input", Text: in.Text, Ref: in.Ref})
			return
		}
		break
	}
	b.ep.Post(in.Topic, "session not attached", in.Ref, false)
}

func (b *Broker) sessionList() string {
	if len(b.conns) == 0 {
		return "No attached sessions."
	}
	names := make([]string, 0, len(b.conns))
	for _, c := range b.conns {
		names = append(names, "- "+c.Name) // a Markdown list: single newlines would merge lines
	}
	sort.Strings(names)
	return "Attached sessions:\n\n" + strings.Join(names, "\n")
}

// ---- Helpers ----

// post sends a message to a session's topic. ok is false only if the topic is gone,
// in which case the session has been dropped. A rejected message yields ok with msgID "".
func (b *Broker) post(session, text, replyTo string, notify bool) (msgID string, ok bool) {
	msgID, err := b.ep.Post(b.state.Sessions[session].Topic, text, replyTo, notify)
	if errors.Is(err, ErrTopicGone) {
		b.dropSession(session)
		return "", false
	}
	if err != nil {
		log.Printf("session %s: post rejected: %v", session, err)
	}
	return msgID, true
}

func (b *Broker) flushDraft() bool {
	for session, text := range b.drafts {
		delete(b.drafts, session)
		s := b.state.Sessions[session]
		if s == nil || b.conns[session] == nil {
			return true
		}
		if err := b.ep.Draft(s.Topic, text); errors.Is(err, ErrTopicGone) {
			b.dropSession(session)
		}
		return true
	}
	return false
}

// dropSession forgets a session whose topic was deleted. The extension reconnects
// into a fresh topic and replays.
func (b *Broker) dropSession(session string) {
	log.Printf("session %s: topic gone, dropping", session)
	delete(b.state.Sessions, session)
	delete(b.drafts, session)
	if c := b.conns[session]; c != nil {
		delete(b.conns, session)
		c.w.Close()
	}
	b.save()
}

func (b *Broker) save() {
	if err := saveState(b.statePath, b.state); err != nil {
		log.Printf("save state: %v", err)
	}
}

// messageID finds the endpoint message id for a key, or "".
func messageID(s *Session, key string) string {
	if key == "" {
		return ""
	}
	for _, p := range s.Posted {
		if p[0] == key {
			return p[1]
		}
	}
	return ""
}

// send writes one frame to an extension. A failed write closes the connection;
// its reader then reports Closed.
func send(c *Conn, f Frame) {
	line, _ := json.Marshal(f)
	if d, ok := c.w.(interface{ SetWriteDeadline(time.Time) error }); ok {
		d.SetWriteDeadline(time.Now().Add(5 * time.Second))
	}
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		c.w.Close()
	}
}
