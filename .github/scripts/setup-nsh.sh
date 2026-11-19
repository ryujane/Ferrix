#!/usr/bin/env bash
set -euo pipefail

archive="$1"
url="https://github.com/longbridge/nsh/releases/download/$NSH_VERSION/$archive"
mkdir -p .nsh/release-tools
cd .nsh/release-tools

curl --fail --silent --show-error --location --retry 3 --remote-name "$url" --remote-name "$url.sha256"
if [[ $RUNNER_OS == macOS ]]; then
  shasum -a 256 -c "$archive.sha256"
else
  sha256sum -c "$archive.sha256"
fi

if [[ $RUNNER_OS == Windows ]]; then
  unzip -q "$archive"
  cygpath -w "$PWD/nsh/bin" >> "$GITHUB_PATH"
else
  tar -xzf "$archive"
  printf '%s\n' "$PWD/nsh/bin" >> "$GITHUB_PATH"
fi
