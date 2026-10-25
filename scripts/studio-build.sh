#!/bin/bash
# Bind a production build to the clean source revision that produced it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test -z "$(git status --porcelain)" || { echo 'Commit source changes before building a release.'; exit 1; }
revision=$(git rev-parse HEAD)
build_data=$(mktemp -d)
trap 'rm -rf "$build_data"' EXIT
DATA_DIR="$build_data" DISABLE_BACKGROUND_TOKEN_REFRESH=1 npm run build
test "$revision" = "$(git rev-parse HEAD)" && test -z "$(git status --porcelain)" || {
  echo 'Source changed during the build; release is not eligible for staging.'
  exit 1
}
node - "$revision" <<'JS'
const fs = require('node:fs');
fs.writeFileSync('.next/standalone/studio-build.json', JSON.stringify({ revision: process.argv[2], completedAt: new Date().toISOString() }));
JS
