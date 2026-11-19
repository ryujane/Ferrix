#!/usr/bin/env bash
set -euo pipefail

app="$1"
output="$2"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

ditto "$app" "$staging/Ferrix.app"
ln -s /Applications "$staging/Applications"
hdiutil create -ov -volname Ferrix -srcfolder "$staging" -fs HFS+ -format UDZO "$output"
