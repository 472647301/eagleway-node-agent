#!/usr/bin/env bash
# Run after pnpm build. Uses the same pinned artifact and verifier as the helper.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
xray_test_dir="$(mktemp -d)"
trap 'rm -rf "$xray_test_dir"' EXIT
export XRAY_TEST_ARCHIVE="$xray_test_dir/xray.zip"

node <<'NODE'
const { xrayArtifact } = require('./dist/host/xray-release')
const { downloadVerifiedArtifact } = require('./dist/host/artifact-downloader')
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('This downloader supports Linux x64/arm64 only')
}
const artifact = xrayArtifact(process.arch)
downloadVerifiedArtifact({
  url: artifact.url,
  target: process.env.XRAY_TEST_ARCHIVE,
  expectedHash: artifact.sha256,
  timeoutMs: 10 * 60 * 1000,
  maxBytes: 128 * 1024 * 1024
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
NODE

unzip -q "$XRAY_TEST_ARCHIVE" xray -d "$xray_test_dir"
chmod 0755 "$xray_test_dir/xray"
XRAY_TEST_BINARY="$xray_test_dir/xray" pnpm test:xray
