# Source and scope

The conntrack implementation and tests in `internal/conntrack` are from
[p0lyfusion/xray-speedlimit](https://github.com/p0lyfusion/xray-speedlimit),
commit `399782563f295975dfdaf217eeb67daae2fdd8ee`, under the included MIT license.

Eagleway uses a separate managed policy service: persistent collision-free marks,
revisioned snapshots, a protected Unix socket, and an owned single-root HTB tree.
It does not run the upstream installer, hash allocator, automatic rate setter or GC.
The single HTB tree also supports single-queue VPS interfaces. Its throughput/CPU
cost must be measured on the target server before broad rollout.
