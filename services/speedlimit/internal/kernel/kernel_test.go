package kernel

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/p0lyfusion/xray-speedlimit/internal/policy"
)

func TestRefusesUnownedQueuesBeforeMutation(t *testing.T) {
	for _, root := range []string{`[{"kind":"cake","handle":"8001:","root":true}]`, `[{"kind":"htb","handle":"ea71:","root":true}]`, `[{"kind":"fq","handle":"0:","root":true},{"kind":"clsact","handle":"ffff:"}]`} {
		d := Driver{Iface: "eth0", Dir: t.TempDir()}
		old := command
		command = func(input, name string, args ...string) ([]byte, error) {
			if strings.Join(args, " ") == "-j qdisc show dev eth0" {
				return []byte(root), nil
			}
			t.Fatal("unexpected command before ownership", name, args)
			return nil, nil
		}
		if d.Reconcile(map[uint32]int{}) == nil {
			t.Fatal("accepted foreign tree")
		}
		command = old
		if _, e := os.Stat(d.Dir + "/ownership.json"); !os.IsNotExist(e) {
			t.Fatal("wrote ownership for foreign tree")
		}
	}
}
func TestReconcileChangesOnlyOwnedClassesAndCleanupRestoresDefault(t *testing.T) {
	d := Driver{Iface: "eth0", Dir: t.TempDir()}
	d.ReadClasses = func(string) (map[uint32]ClassRate, error) {
		return map[uint32]ClassRate{policy.Prefix | 2: {1250000, 1250000}, policy.Prefix | 3: {2500000, 2500000}}, nil
	}
	old := command
	defer func() { command = old }()
	root := `[{"kind":"fq","handle":"0:","root":true}]`
	tableExists := false
	var calls []string
	command = func(input, name string, args ...string) ([]byte, error) {
		call := name + " " + strings.Join(args, " ")
		calls = append(calls, call)
		switch call {
		case "tc -j qdisc show dev eth0":
			return []byte(root), nil
		case "nft list tables":
			if tableExists {
				return []byte("table inet " + table + "\ntable inet firewall\n"), nil
			}
			return []byte("table inet firewall\n"), nil
		case "tc qdisc replace dev eth0 root handle ea71: htb default 0 direct_qlen 1000":
			root = `[{"kind":"htb","handle":"ea71:","root":true}]`
		case "nft -f -":
			if !strings.Contains(input, "ct direction reply ct mark & 0xffff0000 == 0xea710000") || strings.Contains(input, "flush ruleset") {
				t.Fatal("unscoped nft restore", input)
			}
			tableExists = true
		case "tc qdisc del dev eth0 root handle ea71:":
			root = `[{"kind":"fq","handle":"0:","root":true}]`
		case "nft delete table inet eagleway_download_limit":
			tableExists = false
		}
		return nil, nil
	}
	if e := d.Reconcile(map[uint32]int{policy.Prefix | 2: 10}); e != nil {
		t.Fatal(e)
	}
	joined := strings.Join(calls, "\n")
	if strings.Contains(joined, "class replace dev eth0 parent ea71: classid ea71:2") {
		t.Fatal("unchanged class was rebuilt")
	}
	if !strings.Contains(joined, "class del dev eth0 classid ea71:3") {
		t.Fatal("removed assignment retained cap")
	}
	if e := d.Cleanup(); e != nil {
		t.Fatal(e)
	}
	if tableExists || ownedRoot(mustRoots(t, &d)) {
		t.Fatal("owned rules survived explicit disable")
	}
	count := len(calls)
	if e := d.Cleanup(); e != nil {
		t.Fatal(e)
	}
	if len(calls) != count {
		t.Fatal("disabled-without-ownership touched networking")
	}
}
func mustRoots(t *testing.T, d *Driver) []qdisc {
	t.Helper()
	v, e := d.roots()
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestCommandFailureRetainsRecoveryJournal(t *testing.T) {
	d := Driver{Iface: "eth0", Dir: t.TempDir()}
	old := command
	defer func() { command = old }()
	command = func(input, name string, args ...string) ([]byte, error) {
		if name == "nft" && len(args) > 0 && args[0] == "list" {
			return []byte(""), nil
		}
		if len(args) > 0 && args[0] == "-j" {
			return []byte(`[{"kind":"fq","handle":"0:","root":true}]`), nil
		}
		return nil, fmt.Errorf("injected kernel failure")
	}
	if d.Reconcile(map[uint32]int{}) == nil {
		t.Fatal("kernel failure ignored")
	}
	if _, e := os.Stat(d.Dir + "/ownership.json"); e != nil {
		t.Fatal("lost cleanup journal", e)
	}
}
