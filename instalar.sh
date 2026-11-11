#!/usr/bin/env bash
# Instala o actualiza Tienda Almaguer en un VPS (Ubuntu/Debian), como root:
#   curl -fsSL https://raw.githubusercontent.com/h3llu13-dot/tienda-almaguer/main/instalar.sh | bash -s [dominio]
set -euo pipefail
T="$(mktemp -d)"
curl -fsSL https://codeload.github.com/h3llu13-dot/tienda-almaguer/tar.gz/main | tar xz -C "$T"
bash "$T/tienda-almaguer-main/servidor/instalar.sh" "$@"
rm -rf "$T"
