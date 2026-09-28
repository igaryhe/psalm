package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeBotAPI answers Bot API calls with canned responses, in order, and records the methods.
func fakeBotAPI(t *testing.T, responses ...string) (*Telegram, *[]string) {
	var methods []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:])
		w.Write([]byte(responses[0]))
		responses = responses[1:]
	}))
	t.Cleanup(srv.Close)
	tg := NewTelegram("x", 42, 0)
	tg.base = srv.URL + "/botx/"
	return tg, &methods
}

func TestPostFallsBackToPlainText(t *testing.T) {
	tg, methods := fakeBotAPI(t,
		`{"ok":false,"error_code":400,"description":"Bad Request: can't parse rich message"}`,
		`{"ok":true,"result":{"message_id":7}}`)
	id, err := tg.Post("3", "**hi**", "", false)
	check(t, err, nil)
	check(t, id, "7")
	check(t, *methods, []string{"sendRichMessage", "sendMessage"})
}

func TestRetriesAfter429(t *testing.T) {
	tg, methods := fakeBotAPI(t,
		`{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":0}}`,
		`{"ok":true,"result":{"message_id":8}}`)
	id, err := tg.Post("3", "hi", "", true)
	check(t, err, nil)
	check(t, id, "8")
	check(t, len(*methods), 2)
}

func TestDeletedTopic(t *testing.T) {
	tg, _ := fakeBotAPI(t, `{"ok":false,"error_code":400,"description":"Bad Request: message thread not found"}`)
	_, err := tg.Post("3", "hi", "", false)
	check(t, errors.Is(err, ErrTopicGone), true)
}

func TestUpdatesBecomeInputs(t *testing.T) {
	tg := NewTelegram("x", 42, 0)
	parse := func(s string) *Input {
		var u update
		json.Unmarshal([]byte(s), &u)
		return tg.input(u)
	}
	check(t, parse(`{"message":{"message_id":5,"message_thread_id":3,"text":"hi","from":{"id":42}}}`),
		&Input{Topic: "3", Text: "hi", Ref: "5"})
	check(t, parse(`{"message":{"message_id":5,"text":"hi","from":{"id":42}}}`),
		&Input{Topic: "", Text: "hi", Ref: "5"})
	check(t, parse(`{"message":{"message_id":6,"message_thread_id":3,"photo":[],"from":{"id":42}}}`),
		&Input{Topic: "3", Ref: "6", NonText: true})
	check(t, parse(`{"message":{"message_id":7,"message_thread_id":3,"forum_topic_created":{},"from":{"id":42}}}`),
		(*Input)(nil))
	check(t, parse(`{"message":{"message_id":8,"text":"hi","from":{"id":1}}}`), (*Input)(nil))
	check(t, parse(`{"stopped_message_generation":{"message_thread_id":3,"draft_id":3}}`),
		&Input{Topic: "3", Text: "/abort"})
}
