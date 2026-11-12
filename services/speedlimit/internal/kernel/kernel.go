package kernel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/p0lyfusion/xray-speedlimit/internal/policy"
)

const table = "eagleway_download_limit"
const handle = "ea71:"
const ownerChain = "eagleway_managed_v1"

type ownership struct {
	Interface string `json:"interface"`
	RootKind  string `json:"rootKind"`
}
type qdisc struct {
	Kind   string `json:"kind"`
	Handle string `json:"handle"`
	Root   bool   `json:"root"`
}
type ClassRate struct{ Rate, Ceiling uint64 }
type Driver struct {
	Iface, Dir  string
	ReadClasses func(string) (map[uint32]ClassRate, error)
}

var command = executeCommand

func executeCommand(input string, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	if input != "" {
		c.Stdin = strings.NewReader(input)
	}
	out, err := c.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s %v: %w: %.500s", name, args, err, out)
	}
	return out, nil
}
func (d *Driver) roots() ([]qdisc, error) {
	b, e := command("", "tc", "-j", "qdisc", "show", "dev", d.Iface)
	if e != nil {
		return nil, e
	}
	var q []qdisc
	e = json.Unmarshal(b, &q)
	return q, e
}
func ownedRoot(q []qdisc) bool {
	for _, v := range q {
		if v.Root {
			return v.Kind == "htb" && v.Handle == handle
		}
	}
	return false
}
func defaultRoot(q []qdisc) (string, error) {
	kind := ""
	for _, v := range q {
		// Only kernel-created, unnumbered default queues are eligible. Never
		// replace a custom HTB/CAKE tree, ingress, clsact or another owner's rules.
		if v.Handle != "0:" || (v.Kind != "mq" && v.Kind != "fq" && v.Kind != "fq_codel" && v.Kind != "pfifo_fast" && v.Kind != "noqueue") {
			return "", errors.New("interface has a custom qdisc; refusing takeover")
		}
		if v.Root {
			kind = v.Kind
		}
	}
	if kind == "" {
		return "", errors.New("unsupported interface root qdisc")
	}
	return kind, nil
}
func (d *Driver) journal() (ownership, bool, error) {
	b, e := os.ReadFile(d.Dir + "/ownership.json")
	if errors.Is(e, os.ErrNotExist) {
		return ownership{}, false, nil
	}
	if e != nil {
		return ownership{}, false, e
	}
	var v ownership
	if e = json.Unmarshal(b, &v); e != nil {
		return v, false, e
	}
	if v.Interface != d.Iface {
		return v, false, errors.New("interface differs from ownership journal; disable the old interface first")
	}
	return v, true, nil
}

func nftTableExists() (bool, error) {
	out, err := command("", "nft", "list", "tables")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == "table inet "+table {
			return true, nil
		}
	}
	return false, nil
}

func assertNftOwner() error {
	if _, err := command("", "nft", "list", "chain", "inet", table, ownerChain); err != nil {
		return fmt.Errorf("refusing to alter a table without the Eagleway ownership chain: %w", err)
	}
	return nil
}
func (d *Driver) ensure() error {
	if !regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,15}$`).MatchString(d.Iface) || d.Iface == "lo" {
		return errors.New("invalid speed limit interface")
	}
	q, e := d.roots()
	if e != nil {
		return e
	}
	_, owned, e := d.journal()
	if e != nil {
		return e
	}
	if !owned {
		kind, e := defaultRoot(q)
		if e != nil {
			return e
		}
		// Inspect the complete table list so permissions/tool failures are not
		// mistaken for an absent table.
		present, e := nftTableExists()
		if e != nil {
			return e
		}
		if present {
			return errors.New("nft table already exists without ownership")
		}
		if e = policy.Save(d.Dir+"/ownership.json", ownership{d.Iface, kind}); e != nil {
			return e
		}
	}
	present, e := nftTableExists()
	if e != nil {
		return e
	}
	if present {
		if e = assertNftOwner(); e != nil {
			return e
		}
	}
	if !ownedRoot(q) {
		if _, e = defaultRoot(q); e != nil {
			return e
		}
		if _, e = command("", "tc", "qdisc", "replace", "dev", d.Iface, "root", "handle", handle, "htb", "default", "0", "direct_qlen", "1000"); e != nil {
			return e
		}
	}
	// With default 0, HTB sends unclassified packets through its direct queue.
	if _, e = command("", "tc", "filter", "replace", "dev", d.Iface, "parent", handle, "protocol", "all", "pref", "1", "fw"); e != nil {
		return e
	}
	// Scope restore to this mark namespace, this interface and the reply
	// direction. Client uploads and unrelated connections retain their marks.
	var setup string
	if !present {
		setup = fmt.Sprintf("create table inet %s\nadd chain inet %s %s\n", table, table, ownerChain)
	}
	rules := setup + fmt.Sprintf("add chain inet %s output { type filter hook output priority mangle; policy accept; }\nflush chain inet %s output\nadd rule inet %s output oifname %q ct direction reply ct mark & 0xffff0000 == 0xea710000 meta mark set ct mark\n", table, table, table, d.Iface)
	_, e = command(rules, "nft", "-f", "-")
	return e
}
func (d *Driver) Reconcile(rates map[uint32]int) error {
	if e := d.ensure(); e != nil {
		return e
	}
	existing, e := d.ReadClasses(d.Iface)
	if e != nil {
		return e
	}
	for mark, mbps := range rates {
		if mark&0xffff0000 != policy.Prefix || mark&0xffff < 2 {
			return errors.New("invalid class mark")
		}
		if mbps == 0 {
			// Leave any previous class in existing so the deletion pass removes it.
			continue
		}
		bytesPerSecond := uint64(mbps) * 125000
		if existing[mark] == (ClassRate{Rate: bytesPerSecond, Ceiling: bytesPerSecond}) {
			delete(existing, mark)
			continue
		}
		class := fmt.Sprintf("ea71:%x", mark&0xffff)
		// Explicit ceil and bounded burst: connections of one assignment share
		// this single class, even when they use different CPU/TX queues.
		burst := max(uint64(mbps)*125000/50, 16384)
		if _, e = command("", "tc", "class", "replace", "dev", d.Iface, "parent", handle, "classid", class, "htb", "rate", fmt.Sprintf("%dmbit", mbps), "ceil", fmt.Sprintf("%dmbit", mbps), "burst", fmt.Sprintf("%db", burst), "cburst", fmt.Sprintf("%db", burst)); e != nil {
			return e
		}
		delete(existing, mark)
	}
	for mark := range existing {
		if _, e = command("", "tc", "class", "del", "dev", d.Iface, "classid", fmt.Sprintf("ea71:%x", mark&0xffff)); e != nil {
			return e
		}
	}
	return nil
}

// Cleanup is explicit. A crashing/restarting process leaves rules in place.
func (d *Driver) Cleanup() error {
	before, owned, e := d.journal()
	if e != nil || !owned {
		return e
	}
	q, e := d.roots()
	if e != nil {
		return e
	}
	if !ownedRoot(q) {
		if _, e = defaultRoot(q); e != nil {
			return e
		}
	}
	// Delete only our own table; never flush the host ruleset.
	present, e := nftTableExists()
	if e != nil {
		return e
	}
	if present {
		if e = assertNftOwner(); e != nil {
			return e
		}
		if _, e = command("", "nft", "delete", "table", "inet", table); e != nil {
			return e
		}
	}
	if ownedRoot(q) {
		if _, e = command("", "tc", "qdisc", "del", "dev", d.Iface, "root", "handle", handle); e != nil {
			return e
		}
	}
	restored, e := d.roots()
	if e != nil {
		return e
	}
	kind, e := defaultRoot(restored)
	if e != nil {
		return e
	}
	if kind != before.RootKind {
		return fmt.Errorf("kernel restored %s, expected %s; retaining ownership journal", kind, before.RootKind)
	}
	// Deleting an owned root restores the kernel's default queues. Keep the
	// allocations file: old conntrack entries must never collide on re-enable.
	return os.Remove(d.Dir + "/ownership.json")
}
