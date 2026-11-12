//go:build linux

package kernel

import (
	"os"
	"os/exec"
	"testing"

	"github.com/p0lyfusion/xray-speedlimit/internal/policy"
)

// Run only through scripts/test-speedlimit-kernel.sh in a throwaway network
// namespace. This checks real tc/nft syntax, class updates and cleanup; it is
// not an end-to-end Xray bandwidth benchmark.
func TestLiveOwnedLayout(t *testing.T) {
	if os.Getenv("EAGLEWAY_LIMIT_NETNS") != "1" {
		t.Skip("requires isolated network namespace")
	}
	if os.Geteuid() != 0 {
		t.Fatal("requires CAP_NET_ADMIN")
	}
	if out, e := exec.Command("ip", "link", "add", "ewlimit-test", "type", "veth", "peer", "name", "ewlimit-peer").CombinedOutput(); e != nil {
		t.Fatalf("create test interface: %v %s", e, out)
	}
	t.Cleanup(func() { exec.Command("ip", "link", "del", "ewlimit-test").Run() })
	for _, device := range []string{"ewlimit-test", "ewlimit-peer"} {
		if out, err := exec.Command("ip", "link", "set", device, "up").CombinedOutput(); err != nil {
			t.Fatalf("bring up %s: %v %s", device, err, out)
		}
	}
	d := Driver{Iface: "ewlimit-test", Dir: t.TempDir(), ReadClasses: HTBClasses}
	before, e := d.roots()
	if e != nil {
		t.Fatal(e)
	}
	for _, rate := range []int{10, 20, 0} {
		if e = d.Reconcile(map[uint32]int{policy.Prefix | 2: rate}); e != nil {
			t.Fatalf("apply %d Mbps to interface with original queues %+v: %v", rate, before, e)
		}
		classes, e := HTBClasses(d.Iface)
		if e != nil {
			t.Fatal(e)
		}
		class, found := classes[policy.Prefix|2]
		expected := uint64(rate) * 125000
		if found != (rate > 0) || class.Rate != expected || class.Ceiling != expected {
			t.Fatalf("class %v for requested limit %d", class, rate)
		}
	}
	if e = d.Reconcile(map[uint32]int{}); e != nil {
		t.Fatal(e)
	}
	if e = d.Cleanup(); e != nil {
		t.Fatal(e)
	}
	after, e := d.roots()
	if e != nil {
		t.Fatal(e)
	}
	beforeKind, e := defaultRoot(before)
	if e != nil {
		t.Fatal(e)
	}
	afterKind, e := defaultRoot(after)
	if e != nil {
		t.Fatal(e)
	}
	if beforeKind != afterKind {
		t.Fatalf("default queue changed: %s -> %s", beforeKind, afterKind)
	}
	if e = d.Cleanup(); e != nil {
		t.Fatal("disable must be idempotent", e)
	}
}
