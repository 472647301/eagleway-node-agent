#!/bin/bash
set -Eeuo pipefail

readonly GITHUB_REPOSITORY="472647301/eagleway-node-agent"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly RELEASE_TEMPLATE="${SCRIPT_DIR}/../.env.example"
readonly DEFAULT_CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/eagleway-node-agent"
readonly DEFAULT_ENV_FILE="${DEFAULT_CONFIG_ROOT}/agent.env"

usage() {
  echo "Usage: $0 <release-tag> [env-file]" >&2
  echo "Example: $0 v0.1.0" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage

RELEASE_TAG="$1"
ENV_FILE_INPUT="${2:-${DEFAULT_ENV_FILE}}"

[[ "${RELEASE_TAG}" =~ ^v[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || {
  echo "Release tag must start with v and contain only letters, numbers, dot, underscore, or dash" >&2
  exit 2
}

for command_name in curl install mktemp realpath sha256sum tar uname; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "Missing required command: ${command_name}" >&2
    exit 1
  }
done
if [[ "${EUID}" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || {
    echo "Missing required command: sudo" >&2
    exit 1
  }
fi

if [[ ! -f "${ENV_FILE_INPUT}" ]]; then
  TEMPLATE_SOURCE="${RELEASE_TEMPLATE}"
  DOWNLOADED_TEMPLATE=""
  if [[ ! -f "${TEMPLATE_SOURCE}" ]]; then
    DOWNLOADED_TEMPLATE="$(mktemp -t eagleway-env.XXXXXXXX)"
    if ! curl --fail --silent --show-error --location --retry 3 \
      "https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${RELEASE_TAG}/.env.example" \
      --output "${DOWNLOADED_TEMPLATE}"; then
      rm -f -- "${DOWNLOADED_TEMPLATE}"
      exit 1
    fi
    TEMPLATE_SOURCE="${DOWNLOADED_TEMPLATE}"
  fi
  install -d -m 0700 "$(dirname -- "${ENV_FILE_INPUT}")"
  install -m 0600 "${TEMPLATE_SOURCE}" "${ENV_FILE_INPUT}"
  [[ -z "${DOWNLOADED_TEMPLATE}" ]] || rm -f -- "${DOWNLOADED_TEMPLATE}"
  echo "Created ${ENV_FILE_INPUT}"
  if [[ -t 0 && -t 1 ]]; then
    if command -v vim >/dev/null 2>&1; then
      vim "${ENV_FILE_INPUT}"
    elif command -v vi >/dev/null 2>&1; then
      vi "${ENV_FILE_INPUT}"
    else
      echo "Vim/vi is not installed. Edit this file, then rerun: $0 ${RELEASE_TAG} ${ENV_FILE_INPUT}"
      exit 2
    fi
  else
    echo "Edit this file, then rerun: $0 ${RELEASE_TAG} ${ENV_FILE_INPUT}"
    exit 2
  fi
fi
ENV_FILE="$(realpath "${ENV_FILE_INPUT}")"

case "$(uname -m)" in
  x86_64 | amd64)
    RELEASE_ARCH="x64"
    ;;
  aarch64 | arm64)
    RELEASE_ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

ARCHIVE_NAME="eagleway-node-agent-linux-${RELEASE_ARCH}.tar.gz"
CHECKSUM_NAME="${ARCHIVE_NAME}.sha256"
STAGING_DIR="$(mktemp -d -t eagleway-node-agent.XXXXXXXX)"
RELEASE_DIR="${STAGING_DIR}/release"

cleanup() {
  rm -rf -- "${STAGING_DIR}"
}
trap cleanup EXIT

echo "Downloading ${GITHUB_REPOSITORY} ${RELEASE_TAG} for linux-${RELEASE_ARCH}..."
RELEASE_URL="https://github.com/${GITHUB_REPOSITORY}/releases/download/${RELEASE_TAG}"
curl --fail --silent --show-error --location --retry 3 \
  "${RELEASE_URL}/${ARCHIVE_NAME}" \
  --output "${STAGING_DIR}/${ARCHIVE_NAME}"
curl --fail --silent --show-error --location --retry 3 \
  "${RELEASE_URL}/${CHECKSUM_NAME}" \
  --output "${STAGING_DIR}/${CHECKSUM_NAME}"

(
  cd "${STAGING_DIR}"
  sha256sum --strict --check "${CHECKSUM_NAME}"
)

install -d -m 0755 "${RELEASE_DIR}"
tar -xzf "${STAGING_DIR}/${ARCHIVE_NAME}" -C "${RELEASE_DIR}"
[[ -x "${RELEASE_DIR}/scripts/bootstrap-ubuntu.sh" ]] || {
  echo "Release archive does not contain an executable bootstrap script" >&2
  exit 1
}

if [[ "${EUID}" -eq 0 ]]; then
  "${RELEASE_DIR}/scripts/bootstrap-ubuntu.sh" "${RELEASE_DIR}" "${ENV_FILE}"
else
  sudo "${RELEASE_DIR}/scripts/bootstrap-ubuntu.sh" "${RELEASE_DIR}" "${ENV_FILE}"
fi

echo
echo "Deployment completed. Useful commands:"
echo "  sudo -u eagleway-agent -H pm2 status"
echo "  sudo -u eagleway-agent -H pm2 logs eagleway-node-agent --lines 200"
echo "  curl -fsS http://127.0.0.1:8086/api/health"
