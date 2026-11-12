// Package policy owns persistent assignment-to-mark allocations and desired rates.
package policy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

const Prefix uint32 = 0xea710000
const MaxMbps = 1000000

var emailPattern = regexp.MustCompile(`^(trojan|vless|vmess)\.[0-9a-fA-F-]{36}@eagleway\.internal$`)

type User struct {
	Email string `json:"email"`
	Mbps  int    `json:"mbps"`
}
type Snapshot struct {
	Revision int64  `json:"revision"`
	Users    []User `json:"users"`
}
type Disk struct {
	Snapshot Snapshot          `json:"snapshot"`
	Marks    map[string]uint32 `json:"marks"`
	Next     uint32            `json:"next"`
}
type Driver interface{ Reconcile(map[uint32]int) error }
type Status struct {
	State           string `json:"state"`
	DesiredRevision int64  `json:"desiredRevision"`
	AppliedRevision int64  `json:"appliedRevision"`
	Error           string `json:"error,omitempty"`
}
type Store struct {
	mu        sync.RWMutex
	operation sync.Mutex
	disk      Disk
	path      string
	driver    Driver
	status    Status
}

func Open(path string, driver Driver) (*Store, error) {
	s := &Store{path: path, driver: driver, disk: Disk{Marks: map[string]uint32{}, Next: 2}, status: Status{State: "pending"}}
	b, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(b, &s.disk); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// Never silently reset allocations: conntrack marks can outlive this process.
	if s.disk.Marks == nil || s.disk.Next < 2 || s.disk.Next > 65536 {
		return nil, errors.New("invalid persisted allocations")
	}
	seen := map[uint32]bool{}
	for _, m := range s.disk.Marks {
		if m&0xffff0000 != Prefix || m&0xffff < 2 || m&0xffff >= s.disk.Next || seen[m] {
			return nil, errors.New("invalid or duplicate persisted mark")
		}
		seen[m] = true
	}
	if err = validate(s.disk.Snapshot); err != nil {
		return nil, err
	}
	for _, u := range s.disk.Snapshot.Users {
		if s.disk.Marks[u.Email] == 0 {
			return nil, errors.New("missing persisted allocation")
		}
	}
	return s, nil
}
func validate(v Snapshot) error {
	if v.Revision < 0 || v.Revision > 9007199254740991 || len(v.Users) > 10000 {
		return errors.New("invalid snapshot")
	}
	seen := map[string]bool{}
	for _, u := range v.Users {
		if !emailPattern.MatchString(u.Email) || u.Mbps < 0 || u.Mbps > MaxMbps || seen[u.Email] {
			return errors.New("invalid or duplicate policy")
		}
		seen[u.Email] = true
	}
	return nil
}
func (s *Store) Sync(v Snapshot) error {
	s.operation.Lock()
	defer s.operation.Unlock()
	if err := s.saveSnapshot(v); err != nil {
		return err
	}
	return s.reconcile()
}
func (s *Store) saveSnapshot(v Snapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validate(v); err != nil {
		return err
	}
	if v.Revision < s.disk.Snapshot.Revision {
		return errors.New("stale revision")
	}
	old, _ := json.Marshal(s.disk.Snapshot)
	incoming, _ := json.Marshal(v)
	if v.Revision == s.disk.Snapshot.Revision && string(old) != string(incoming) {
		return errors.New("revision conflict")
	}
	d := Disk{Snapshot: v, Next: s.disk.Next, Marks: map[string]uint32{}}
	for e, m := range s.disk.Marks {
		d.Marks[e] = m
	}
	for _, u := range v.Users {
		if d.Marks[u.Email] == 0 {
			if d.Next > 65535 {
				return errors.New("mark capacity exhausted; allocations are never recycled")
			}
			d.Marks[u.Email] = Prefix | d.Next
			d.Next++
		}
	}
	if err := Save(s.path, d); err != nil {
		return err
	}
	s.disk = d
	return nil
}
func (s *Store) Reconcile() error {
	s.operation.Lock()
	defer s.operation.Unlock()
	return s.reconcile()
}
func (s *Store) reconcile() error {
	s.mu.Lock()
	rates := map[uint32]int{}
	for _, u := range s.disk.Snapshot.Users {
		rates[s.disk.Marks[u.Email]] = u.Mbps
	}
	s.status.DesiredRevision = s.disk.Snapshot.Revision
	revision := s.disk.Snapshot.Revision
	if s.status.AppliedRevision != revision {
		s.status.State = "pending"
	}
	s.mu.Unlock()
	// Kernel work must not block webhook lookups or health checks.
	err := s.driver.Reconcile(rates)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.status.State = "degraded"
		s.status.Error = err.Error()
		return err
	}
	s.status = Status{State: "ready", DesiredRevision: revision, AppliedRevision: revision}
	return nil
}
func (s *Store) Mark(email string) uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !emailPattern.MatchString(email) {
		return 0
	}
	if m := s.disk.Marks[email]; m != 0 {
		return m
	}
	// An authenticated Xray connection can arrive before the next policy
	// snapshot. Mark it now, even while unlimited, so a later limit also
	// affects this existing connection. Authentication remains Xray's job.
	if s.disk.Next > 65535 {
		return 0
	}
	m := Prefix | s.disk.Next
	s.disk.Marks[email] = m
	s.disk.Next++
	if err := Save(s.path, s.disk); err != nil {
		delete(s.disk.Marks, email)
		s.disk.Next--
		s.status.State = "degraded"
		s.status.Error = "failed to persist connection allocation"
		return 0
	}
	return m
}
func (s *Store) Status() Status { s.mu.RLock(); defer s.mu.RUnlock(); return s.status }
func Save(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		return fmt.Errorf("persist policy: %w", err)
	}
	return nil
}
