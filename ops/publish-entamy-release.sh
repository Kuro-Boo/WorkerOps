#!/usr/bin/env bash
# WorkerOpsの不変成果物をEntamy配信基盤へ署名して発行する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE="$(cd "$PRODUCT_DIR/../.." && pwd)"
VERSION="$(node -p "require('$PRODUCT_DIR/package.json').version")"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "package version must be semantic version X.Y.Z" >&2
  exit 2
}

cd "$PRODUCT_DIR"
npm run typecheck
npm test
npm run release:bundle

grep -qF "\"$VERSION\"" "$PRODUCT_DIR/dist/worker.js" || {
  echo "dist/worker.js does not contain version $VERSION" >&2
  exit 1
}

ENTAMY_PUBLISH_REQUIRED=1 \
node "$WORKSPACE/Libraries/entamy-connect/ops/release-publish.mjs" \
  workerops "$VERSION" "$PRODUCT_DIR/dist/worker.js"

echo "✓ WorkerOps $VERSION was published to the Entamy release store"
