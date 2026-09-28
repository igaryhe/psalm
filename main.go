// psalm broker: relays pi sessions to Telegram. See docs/design.md.
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
)

func main() {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".config", "psalm")
	configPath := flag.String("config", filepath.Join(dir, "config.json"), "config file")
	flag.Parse()
	dir = filepath.Dir(*configPath)

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	token, err := loadToken(filepath.Join(dir, "token"))
	if err != nil {
		log.Fatal(err)
	}
	statePath := filepath.Join(dir, "state.json")
	state, err := loadState(statePath)
	if err != nil {
		log.Fatal(err)
	}

	tg := NewTelegram(cfg.Telegram.Token, cfg.Telegram.Owner, cfg.Interval)
	if err := tg.Setup(); err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("psalm listening on %s", cfg.Listen)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	b := NewBroker(state, statePath, token, tg)
	go Listen(ln, b.events)
	go tg.Poll(ctx, b.events)
	b.Run(ctx)
	ln.Close()
}
