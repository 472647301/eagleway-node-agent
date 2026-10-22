#!/bin/bash
# Shared by Bootstrap and runtime-selection tests. Sourcing this file has no side effects.
readonly EAGLEWAY_NODE_VERSION="22.23.4"
readonly EAGLEWAY_NODE_MIN_VERSION="22.23.4"

node_version_supported() {
  local version="${1#v}"
  local minimum_major minimum_minor minimum_patch
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "${EAGLEWAY_NODE_MIN_VERSION}"
  [[ "${version}" =~ ^22\.([0-9]+)\.([0-9]+)$ ]] || return 1
  (( 10#${BASH_REMATCH[1]} > minimum_minor \
    || (10#${BASH_REMATCH[1]} == minimum_minor && 10#${BASH_REMATCH[2]} >= minimum_patch) ))
}

trusted_path_chain() {
  local entry="$1" owner mode
  while :; do
    read -r owner mode <<< "$(stat -Lc '%u %a' -- "${entry}")" || return 1
    [[ "${owner}" == 0 && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#${mode} & 0022) == 0 )) || return 1
    [[ "${entry}" != / ]] || break
    entry="$(dirname -- "${entry}")"
  done
}

trusted_node_path() {
  local candidate="$1" lexical resolved
  [[ "${candidate}" == /* && -f "${candidate}" && -x "${candidate}" ]] || return 1
  lexical="$(realpath -ms -- "${candidate}")" || return 1
  resolved="$(realpath -e -- "${candidate}")" || return 1
  # Check both the supplied symlink path and its target before executing as root.
  trusted_path_chain "${lexical}" && trusted_path_chain "${resolved}" || return 1
  printf '%s\n' "${resolved}"
}

probe_node_runtime() {
  local candidate="$1" arch="$2" service_user="${3:-}" details extra
  local runner=(env)
  candidate="$(trusted_node_path "${candidate}")" || return 1
  [[ -z "${service_user}" ]] || runner=(runuser -u "${service_user}" -- env)
  details="$(cd / && "${runner[@]}" -i HOME=/ PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    "${candidate}" -p '[process.versions.node, process.platform, process.arch, process.versions.modules].join(" ")' 2>/dev/null)" || return 1
  read -r NODE_VERSION NODE_PLATFORM NODE_ARCH NODE_ABI extra <<< "${details}"
  [[ -z "${extra}" && "${NODE_PLATFORM}" == linux && "${NODE_ARCH}" == "${arch}" \
    && "${NODE_ABI}" =~ ^[0-9]+$ ]] || return 1
  node_version_supported "${NODE_VERSION}" || return 1
  NODE_BIN="$(realpath -e -- "${candidate}")"
}

node_archive_sha256() {
  case "$1" in
    x64) echo 1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
    arm64) echo 6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;;
    *) echo "Unsupported Node.js architecture: $1" >&2; return 1 ;;
  esac
}

install_managed_node() (
  set -Eeuo pipefail
  local install_root="$1" arch="$2" archive hash runtime_dir
  archive="node-v${EAGLEWAY_NODE_VERSION}-linux-${arch}.tar.xz"
  hash="$(node_archive_sha256 "${arch}")" || exit 1
  runtime_dir="${install_root}/runtimes/node-v${EAGLEWAY_NODE_VERSION}-linux-${arch}"
  if [[ -e "${runtime_dir}" || -L "${runtime_dir}" ]]; then
    echo "Managed Node.js is unusable: ${runtime_dir}; inspect it before retrying" >&2
    exit 1
  fi
  install -d -o root -g root -m 0755 "${install_root}/runtimes" || exit 1
  staging="$(mktemp -d "${install_root}/runtimes/.node.XXXXXXXX")" || exit 1
  trap 'rm -rf -- "${staging}"' EXIT
  echo "Installing private Node.js ${EAGLEWAY_NODE_VERSION} for ${arch}..." >&2
  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 \
    "https://nodejs.org/dist/v${EAGLEWAY_NODE_VERSION}/${archive}" \
    --output "${staging}/${archive}" || exit 1
  (
    cd "${staging}" || exit 1
    printf '%s  %s\n' "${hash}" "${archive}" | sha256sum --strict --check >&2
  ) || exit 1
  mkdir "${staging}/package" || exit 1
  tar --extract --xz --file "${staging}/${archive}" --strip-components=1 \
    --no-same-owner --directory "${staging}/package" || exit 1
  chown -R root:root "${staging}/package" || exit 1
  chmod -R go-w "${staging}/package" || exit 1
  mv -- "${staging}/package" "${runtime_dir}" || exit 1
)

select_node_runtime() {
  local candidate="$1" install_root="$2" arch="$3" service_user="${4:-}" path
  local managed="${install_root}/runtimes/node-v${EAGLEWAY_NODE_VERSION}-linux-${arch}/bin/node"
  for path in "${candidate}" /usr/bin/node /usr/local/bin/node "${managed}"; do
    [[ -n "${path}" ]] || continue
    if probe_node_runtime "${path}" "${arch}" "${service_user}"; then
      echo "Using Node.js ${NODE_VERSION}: ${NODE_BIN}" >&2
      return
    fi
    [[ ! -e "${path}" ]] || echo "Node.js at ${path} is incompatible, inaccessible, or not root-owned; skipping" >&2
  done
  install_managed_node "${install_root}" "${arch}" || return 1
  probe_node_runtime "${managed}" "${arch}" "${service_user}" || {
    echo "Private Node.js failed its version/platform/architecture checks" >&2
    return 1
  }
  echo "Using private Node.js ${NODE_VERSION}: ${NODE_BIN}" >&2
}
