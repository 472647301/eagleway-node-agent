#!/bin/bash
set -Eeuo pipefail
cd "$(dirname -- "$0")/../services/speedlimit"
for tool in go ip tc nft unshare; do command -v "${tool}" >/dev/null; done
mkdir -p bin
go test -c -o bin/kernel.test ./internal/kernel
# Every network mutation is confined to a new namespace, destroyed on exit.
sudo unshare --net env EAGLEWAY_LIMIT_NETNS=1 "${PWD}/bin/kernel.test" -test.v -test.run '^TestLiveOwnedLayout$'
