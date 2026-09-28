// Loading and saving files: config, token and state.json.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func loadConfig(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(stripComments(data), &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:7433"
	}
	c.Interval = time.Second
	if c.RawInterval != "" {
		if c.Interval, err = time.ParseDuration(c.RawInterval); err != nil {
			return c, fmt.Errorf("%s: interval: %w", path, err)
		}
	}
	if t := os.Getenv("PSALM_TELEGRAM_TOKEN"); t != "" {
		c.Telegram.Token = t
	}
	if c.Telegram.Token == "" {
		return c, fmt.Errorf("%s: telegram.token is not set", path)
	}
	return c, nil
}

// stripComments removes // comments outside strings, so the config file may be annotated.
func stripComments(data []byte) []byte {
	out := make([]byte, 0, len(data))
	inString, escaped := false, false
	for i := 0; i < len(data); i++ {
		ch := data[i]
		switch {
		case inString:
			inString = escaped || ch != '"'
			escaped = !escaped && ch == '\\'
		case ch == '"':
			inString = true
		case ch == '/' && i+1 < len(data) && data[i+1] == '/':
			for i < len(data) && data[i] != '\n' {
				i++
			}
			if i < len(data) {
				out = append(out, '\n')
			}
			continue
		}
		out = append(out, ch)
	}
	return out
}

// loadToken reads the shared secret, creating a random one on first start.
func loadToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		return strings.TrimSpace(string(data)), nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	buf := make([]byte, 24)
	rand.Read(buf)
	token := hex.EncodeToString(buf)
	return token, os.WriteFile(path, []byte(token+"\n"), 0o600)
}

func loadState(path string) (State, error) {
	var s State
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return State{Sessions: map[string]*Session{}}, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, fmt.Errorf("%s: %w", path, err)
	}
	if s.Sessions == nil {
		s.Sessions = map[string]*Session{}
	}
	return s, nil
}

// saveState rewrites the whole file: write a temporary file, then rename it over the old one.
func saveState(path string, s State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Clean(path))
}
