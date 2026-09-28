package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fakeEndpoint records calls and hands out sequential ids.
type fakeEndpoint struct {
	calls     []string
	next      int
	goneTopic string // topic that reports ErrTopicGone
}

func (f *fakeEndpoint) id() string { f.next++; return fmt.Sprint(f.next) }

func (f *fakeEndpoint) CreateTopic(name string) (string, error) {
	t := f.id()
	f.calls = append(f.calls, "create "+name+" -> "+t)
	return t, nil
}
func (f *fakeEndpoint) RenameTopic(topic, name string) error {
	if f.goneTopic != "" && topic == f.goneTopic {
		return ErrTopicGone
	}
	f.calls = append(f.calls, "rename "+topic+" "+name)
	return nil
}
func (f *fakeEndpoint) Post(topic, text, replyTo string, notify bool) (string, error) {
	if f.goneTopic != "" && topic == f.goneTopic {
		return "", ErrTopicGone
	}
	m := f.id()
	f.calls = append(f.calls, fmt.Sprintf("post %s %q reply=%s notify=%v -> %s", topic, text, replyTo, notify, m))
	return m, nil
}
func (f *fakeEndpoint) Draft(topic, text string) error {
	f.calls = append(f.calls, fmt.Sprintf("draft %s %q", topic, text))
	return nil
}
func (f *fakeEndpoint) Poll(ctx context.Context, out chan<- Event) error { return nil }

// fakeWire captures frames the broker writes to an extension.
type fakeWire struct {
	frames []Frame
	closed bool
}

func (w *fakeWire) Write(p []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimSpace(string(p)), "\n") {
		var f Frame
		json.Unmarshal([]byte(line), &f)
		w.frames = append(w.frames, f)
	}
	return len(p), nil
}
func (w *fakeWire) Close() error { w.closed = true; return nil }

func setup(t *testing.T) (*Broker, *fakeEndpoint) {
	ep := &fakeEndpoint{}
	b := NewBroker(State{}, filepath.Join(t.TempDir(), "state.json"), "secret", ep)
	return b, ep
}

func connect(b *Broker, session, name string) (*Conn, *fakeWire) {
	w := &fakeWire{}
	c := &Conn{ID: 1, w: w}
	b.apply(Event{Conn: c, Frame: &Frame{T: "hello", Token: "secret", Session: session, Name: name}})
	return c, w
}

func frame(b *Broker, c *Conn, f Frame) { b.apply(Event{Conn: c, Frame: &f}) }

func check(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("\ngot  %#v\nwant %#v", got, want)
	}
}

func TestHelloCreatesTopicAndWelcomes(t *testing.T) {
	b, ep := setup(t)
	_, w := connect(b, "s1", "auth")
	check(t, ep.calls, []string{
		"create auth -> 1",
		`post 1 "⏎ attached" reply= notify=false -> 2`,
	})
	check(t, w.frames, []Frame{{T: "welcome"}})
}

func TestBadTokenIsRejected(t *testing.T) {
	b, ep := setup(t)
	w := &fakeWire{}
	b.apply(Event{Conn: &Conn{w: w}, Frame: &Frame{T: "hello", Token: "nope", Session: "s1"}})
	check(t, w.closed, true)
	check(t, len(ep.calls), 0)
}

func TestPostsAreRecordedAndReplyToResolves(t *testing.T) {
	b, ep := setup(t)
	c, _ := connect(b, "s1", "auth")
	frame(b, c, Frame{T: "post", Key: "u1", Text: "👤 hi"})
	frame(b, c, Frame{T: "post", Key: "a1", Ref: "99"})
	frame(b, c, Frame{T: "post", Text: "🌿 Branched from here", ReplyTo: "u1"})
	frame(b, c, Frame{T: "post", Key: "a2", Text: "done", Notify: true})
	check(t, ep.calls[2:], []string{
		`post 1 "👤 hi" reply= notify=false -> 3`,
		`post 1 "🌿 Branched from here" reply=3 notify=false -> 4`,
		`post 1 "done" reply= notify=true -> 5`,
	})
	check(t, b.state.Sessions["s1"].Posted, [][2]string{{"u1", "3"}, {"a1", "99"}, {"a2", "5"}})

	// A reconnect gets the keys back, and the topic is renamed rather than recreated.
	b.apply(Event{Conn: c, Closed: true})
	_, w := connect(b, "s1", "auth v2")
	check(t, w.frames, []Frame{{T: "welcome", Posted: []string{"u1", "a1", "a2"}}})
	check(t, ep.calls[5:], []string{
		`post 1 "⏏ detached" reply= notify=false -> 6`,
		"rename 1 auth v2",
		`post 1 "⏎ attached" reply= notify=false -> 7`,
	})
}

func TestNewConnectionReplacesOld(t *testing.T) {
	b, ep := setup(t)
	old, oldWire := connect(b, "s1", "auth")
	connect(b, "s1", "auth")
	check(t, oldWire.closed, true)
	n := len(ep.calls)
	b.apply(Event{Conn: old, Closed: true}) // the old reader reports its close later
	check(t, len(ep.calls), n)              // no "detached" posted
}

func TestDraftsAreCoalescedAndDroppedByPosts(t *testing.T) {
	b, ep := setup(t)
	c, _ := connect(b, "s1", "auth")
	frame(b, c, Frame{T: "draft", Text: "Let"})
	frame(b, c, Frame{T: "draft", Text: "Let me"})
	check(t, b.flushDraft(), true)
	check(t, b.flushDraft(), false)
	check(t, ep.calls[len(ep.calls)-1], `draft 1 "Let me"`)

	frame(b, c, Frame{T: "draft", Text: "stale"})
	frame(b, c, Frame{T: "post", Key: "a1", Text: "final"})
	check(t, b.flushDraft(), false)
}

func TestInputRouting(t *testing.T) {
	b, ep := setup(t)
	_, w := connect(b, "s1", "auth")
	b.apply(Event{Input: &Input{Topic: "1", Text: "run tests", Ref: "50"}})
	check(t, w.frames[1], Frame{T: "input", Text: "run tests", Ref: "50"})

	b.apply(Event{Input: &Input{Topic: "", Text: "hi"}})
	check(t, ep.calls[len(ep.calls)-1], "post  \"Attached sessions:\\n\\n- auth\" reply= notify=false -> 3")

	b.apply(Event{Input: &Input{Topic: "1", NonText: true, Ref: "51"}})
	check(t, ep.calls[len(ep.calls)-1], `post 1 "only text is supported" reply=51 notify=false -> 4`)

	b.apply(Event{Input: &Input{Topic: "77", Text: "hello?", Ref: "52"}})
	check(t, ep.calls[len(ep.calls)-1], `post 77 "session not attached" reply=52 notify=false -> 5`)
}

func TestDeletedTopicDropsSession(t *testing.T) {
	b, ep := setup(t)
	c, w := connect(b, "s1", "auth")
	ep.goneTopic = "1"
	frame(b, c, Frame{T: "post", Key: "a1", Text: "x"})
	check(t, w.closed, true)
	check(t, b.state.Sessions["s1"], (*Session)(nil))

	_, w2 := connect(b, "s1", "auth") // reconnect: fresh topic, empty history
	check(t, w2.frames, []Frame{{T: "welcome"}})
	check(t, b.state.Sessions["s1"].Topic, "3")
}

func TestStatePersists(t *testing.T) {
	b, _ := setup(t)
	c, _ := connect(b, "s1", "auth")
	frame(b, c, Frame{T: "post", Key: "u1", Text: "hi"})
	s, err := loadState(b.statePath)
	check(t, err, nil)
	check(t, s.Sessions["s1"].Posted, [][2]string{{"u1", "3"}})
}

func TestStripComments(t *testing.T) {
	in := `{
  // full line
  "url": "http://x", // trailing
  "s": "a \" // b"
}`
	var v map[string]string
	check(t, json.Unmarshal(stripComments([]byte(in)), &v), nil)
	check(t, v, map[string]string{"url": "http://x", "s": `a " // b`})
}
