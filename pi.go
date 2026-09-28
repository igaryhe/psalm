// Producers for extension connections: they only turn bytes into Events. See docs/design.md §8.2.
package main

import (
	"bufio"
	"encoding/json"
	"log"
	"net"
)

const maxFrame = 8 << 20 // bytes per line; messages are capped at ~30000 characters

// Listen accepts extension connections and starts one reader per connection.
func Listen(ln net.Listener, events chan<- Event) {
	for id := 1; ; id++ {
		nc, err := ln.Accept()
		if err != nil {
			log.Printf("listener stopped: %v", err)
			return
		}
		go read(&Conn{ID: id, w: nc}, nc, events)
	}
}

// read turns each line into a Frame event, then reports Closed.
func read(c *Conn, nc net.Conn, events chan<- Event) {
	sc := bufio.NewScanner(nc)
	sc.Buffer(make([]byte, 64<<10), maxFrame)
	for sc.Scan() {
		var f Frame
		if err := json.Unmarshal(sc.Bytes(), &f); err != nil {
			log.Printf("conn %d: bad frame: %v", c.ID, err)
			break
		}
		events <- Event{Conn: c, Frame: &f}
	}
	events <- Event{Conn: c, Closed: true}
}
