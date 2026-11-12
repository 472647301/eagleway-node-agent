//go:build linux

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/p0lyfusion/xray-speedlimit/internal/conntrack"
	"github.com/p0lyfusion/xray-speedlimit/internal/kernel"
	"github.com/p0lyfusion/xray-speedlimit/internal/policy"
)

func main() {
	if err := run(); err != nil {
		slog.Error("speed limit", "error", err)
		os.Exit(1)
	}
}
func run() error {
	iface := flag.String("interface", "", "client-facing network interface")
	dir := flag.String("state", "/var/lib/eagleway-speedlimit", "root-owned persistent state")
	socket := flag.String("socket", "/run/eagleway-speedlimit/control.sock", "protected Unix socket")
	cleanup := flag.Bool("cleanup", false, "remove only owned rules; retain allocations")
	flag.Parse()
	d := &kernel.Driver{Iface: *iface, Dir: *dir, ReadClasses: kernel.HTBClasses}
	if *cleanup {
		return d.Cleanup()
	}
	s, err := policy.Open(*dir+"/policies.json", d)
	if err != nil {
		return err
	}
	// Serve degraded status even when kernel setup fails. Xray is independent.
	if err = s.Reconcile(); err != nil {
		slog.Error("initial policy reconciliation", "error", err)
	}
	marker := conntrack.NewMarker(nil)
	var failed atomic.Uint64
	var lastFailure atomic.Int64
	var marked atomic.Uint64
	slots := make(chan struct{}, 64)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		status := s.Status()
		if lastFailure.Load() > time.Now().Add(-time.Minute).Unix() {
			status.State = "degraded"
			status.Error = "recent webhook marking failures"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			policy.Status
			Failed uint64 `json:"failedWebhooks"`
			Marked uint64 `json:"markedConnections"`
		}{status, failed.Load(), marked.Load()})
	})
	mux.HandleFunc("PUT /policies", func(w http.ResponseWriter, r *http.Request) {
		var v policy.Snapshot
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&v); err != nil {
			http.Error(w, "invalid snapshot", 400)
			return
		}
		if err := s.Sync(v); err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /webhook/xray", func(w http.ResponseWriter, r *http.Request) {
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			failed.Add(1)
			lastFailure.Store(time.Now().Unix())
			http.Error(w, "busy", 503)
			return
		}
		var ev struct {
			Email   string `json:"email"`
			Source  string `json:"source"`
			Local   string `json:"inboundLocal"`
			Inbound string `json:"inboundTag"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&ev) != nil {
			http.Error(w, "invalid event", 400)
			return
		}
		protocol, _, valid := strings.Cut(ev.Email, ".")
		if !valid || ev.Inbound != "eagleway-"+protocol {
			w.WriteHeader(204)
			return
		}
		m := s.Mark(ev.Email)
		if m == 0 {
			failed.Add(1)
			lastFailure.Store(time.Now().Unix())
			http.Error(w, "assignment mark unavailable", 503)
			return
		}
		src, e1 := netip.ParseAddrPort(ev.Source)
		dst, e2 := netip.ParseAddrPort(ev.Local)
		if e1 != nil || e2 != nil {
			failed.Add(1)
			lastFailure.Store(time.Now().Unix())
			http.Error(w, "invalid tuple", 400)
			return
		}
		// Agent transports are TCP/TLS. Payload network can be UDP while the
		// client-facing transport is still TCP, so do not discard UDP events.
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			err = marker.SetMark("tcp", net.IP(src.Addr().Unmap().AsSlice()), src.Port(), net.IP(dst.Addr().Unmap().AsSlice()), dst.Port(), m)
			if err == nil {
				break
			}
			time.Sleep(time.Duration(attempt+1) * 20 * time.Millisecond)
		}
		if err != nil {
			failed.Add(1)
			lastFailure.Store(time.Now().Unix())
			http.Error(w, "mark failed", 503)
			return
		}
		marked.Add(1)
		w.WriteHeader(204)
	})
	if err = os.MkdirAll(filepath.Dir(*socket), 0750); err != nil {
		return err
	}
	if info, e := os.Lstat(*socket); e == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("socket path is not a socket")
		}
		if err = os.Remove(*socket); err != nil {
			return err
		}
	}
	l, err := net.Listen("unix", *socket)
	if err != nil {
		return err
	}
	defer l.Close()
	if err = os.Chmod(*socket, 0660); err != nil {
		return err
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 30 * time.Second}
	errs := make(chan error, 1)
	go func() { errs <- server.Serve(l) }()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	for {
		select {
		case <-ticker.C:
			if e := s.Reconcile(); e != nil {
				slog.Error("policy reconciliation", "error", e)
			}
		case <-stop:
			return server.Close()
		case e := <-errs:
			return e
		}
	}
}
