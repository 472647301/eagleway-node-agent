package kernel

import (
	"github.com/p0lyfusion/xray-speedlimit/internal/policy"
	"github.com/vishvananda/netlink"
)

// Some supported versions of iproute2 omit class rates from JSON output.
// Read the actual kernel rates and ceilings in bytes per second via netlink.
func HTBClasses(iface string) (map[uint32]ClassRate, error) {
	link, err := netlink.LinkByName(iface)
	if err != nil {
		return nil, err
	}
	classes, err := netlink.ClassList(link, policy.Prefix)
	if err != nil {
		return nil, err
	}
	rates := make(map[uint32]ClassRate)
	for _, class := range classes {
		htb, ok := class.(*netlink.HtbClass)
		if !ok || htb.LinkIndex != link.Attrs().Index || htb.Handle&0xffff0000 != policy.Prefix || htb.Handle&0xffff < 2 {
			continue
		}
		rates[htb.Handle] = ClassRate{Rate: htb.Rate, Ceiling: htb.Ceil}
	}
	return rates, nil
}
