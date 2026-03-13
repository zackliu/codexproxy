#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SRC="${PROJECT_DIR}/deploy/codexproxy.service"
SERVICE_DEST="/etc/systemd/system/codexproxy.service"
ENV_EXAMPLE="${PROJECT_DIR}/deploy/codexproxy.env.example"
ENV_DEST="/etc/default/codexproxy"

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "Cannot find an executable node in PATH."
  echo "Install Node.js first, then retry."
  exit 1
fi

install -D -m 0644 "${SERVICE_SRC}" "${SERVICE_DEST}"

if [[ ! -f "${ENV_DEST}" ]]; then
  install -D -m 0644 "${ENV_EXAMPLE}" "${ENV_DEST}"
  sed -i "s|^NODE_BIN=.*|NODE_BIN=${NODE_BIN}|" "${ENV_DEST}"
  echo "Created ${ENV_DEST}"
else
  if grep -q "^NODE_BIN=" "${ENV_DEST}"; then
    sed -i "s|^NODE_BIN=.*|NODE_BIN=${NODE_BIN}|" "${ENV_DEST}"
    echo "Updated NODE_BIN in ${ENV_DEST}"
  else
    echo "NODE_BIN=${NODE_BIN}" >> "${ENV_DEST}"
    echo "Added NODE_BIN to ${ENV_DEST}"
  fi
fi

systemctl daemon-reload
systemctl enable --now codexproxy.service

echo
echo "Service enabled and started."
systemctl --no-pager --full status codexproxy.service | sed -n '1,20p'
