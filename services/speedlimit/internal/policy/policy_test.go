package policy

import (
	"errors"
	"path/filepath"
	"testing"
)

type fakeDriver struct {
	rates map[uint32]int
	fail  bool
}

func (d *fakeDriver) Reconcile(r map[uint32]int) error {
	if d.fail {
		return errors.New("kernel unavailable")
	}
	d.rates = r
	return nil
}

const a = "vless.11111111-1111-4111-8111-111111111111@eagleway.internal"
const b = "vless.22222222-2222-4222-8222-222222222222@eagleway.internal"

func TestPersistenceRecoveryAndLiveChange(t *testing.T) {
	p := filepath.Join(t.TempDir(), "policies.json")
	d := &fakeDriver{}
	s, e := Open(p, d)
	if e != nil {
		t.Fatal(e)
	}
	m := s.Mark(a) // connection precedes policy snapshot
	if m == 0 {
		t.Fatal("unlimited connection must receive a stable mark")
	}
	if e = s.Sync(Snapshot{1, []User{{a, 10}, {b, 20}}}); e != nil {
		t.Fatal(e)
	}
	if s.Mark(a) != m || s.Mark(b) == m || d.rates[m] != 10 {
		t.Fatal("allocation or effective rate mismatch")
	}
	d.fail = true
	if s.Sync(Snapshot{2, []User{{a, 30}}}) == nil || s.Status().State != "degraded" || s.Status().AppliedRevision != 1 {
		t.Fatal("partial failure reported as applied")
	}
	d.fail = false
	s, e = Open(p, d)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Reconcile(); e != nil {
		t.Fatal(e)
	}
	if s.Mark(a) != m || d.rates[m] != 30 || s.Status().AppliedRevision != 2 {
		t.Fatal("restart did not restore desired policy")
	}
	if e = s.Sync(Snapshot{3, []User{{a, 0}}}); e != nil {
		t.Fatal(e)
	}
	if d.rates[m] != 0 {
		t.Fatal("clear did not remove cap")
	}
	if e = s.Sync(Snapshot{4, []User{}}); e != nil {
		t.Fatal(e)
	}
	if len(d.rates) != 0 || s.Mark(a) != m {
		t.Fatal("stale class or recycled allocation")
	}
}
func TestRevisionsValidationAndCapacity(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.json"), &fakeDriver{})
	good := Snapshot{2, []User{{a, 10}}}
	if e := s.Sync(good); e != nil {
		t.Fatal(e)
	}
	for _, v := range []Snapshot{{1, good.Users}, {2, []User{{a, 20}}}, {3, []User{{a, -1}}}, {3, []User{{a, 1000001}}}, {3, []User{{a, 1}, {a, 2}}}} {
		if s.Sync(v) == nil {
			t.Fatalf("accepted invalid snapshot: %+v", v)
		}
	}
	if e := s.Sync(good); e != nil {
		t.Fatal("idempotent retry", e)
	}
	s.disk.Next = 65536
	if s.Sync(Snapshot{3, []User{{b, 10}}}) == nil {
		t.Fatal("exhaustion must not recycle marks")
	}
	if s.Mark("unknown") != 0 {
		t.Fatal("invalid email accepted")
	}
}
