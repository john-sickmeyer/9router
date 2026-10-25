#!/bin/bash
# Build a reviewable upstream integration. Never touches the live release.
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
cd "$repo"
test -z "$(git status --porcelain)" || { echo 'Commit or stash source changes first.'; exit 1; }
git fetch origin studio
git fetch upstream master
if git merge-base --is-ancestor upstream/master origin/studio; then
  echo 'Studio already contains the current upstream master. No service changes.'
  exit 0
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
candidate="${repo}-candidate-${stamp}"
branch="upstream-review/${stamp}"
git worktree add -b "$branch" "$candidate" origin/studio
cd "$candidate"
if ! git merge --no-ff upstream/master -m "Merge upstream master into Studio candidate"; then
  echo "Resolve and review conflicts in $candidate. The live service is unchanged."
  exit 1
fi
npm ci --no-audit --no-fund
npm --prefix tests ci --no-audit --no-fund
npm --prefix tests run test:studio
build_data=$(mktemp -d)
trap 'rm -rf "$build_data"' EXIT
DATA_DIR="$build_data" DISABLE_BACKGROUND_TOKEN_REFRESH=1 npm run build
echo "Candidate passed tests and build: $candidate"
echo "Review git diff origin/studio...HEAD. Push this branch and open a PR to studio."
echo "After review/merge, build and stage that exact commit with scripts/studio-release.py."
echo "The live service has not changed. Never reset studio to upstream/master."
