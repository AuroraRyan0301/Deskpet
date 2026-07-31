#!/bin/sh
# Builds the voice sidecar. Plain swiftc: no SwiftPM manifest, no dependencies, one file.
#
# Note on permissions: a bare executable inherits the microphone grant of whatever
# launched it (Terminal when testing, the Electron app in production). The Electron app's
# Info.plist therefore needs NSMicrophoneUsageDescription, and ad-hoc signing loses TCC
# grants on every rebuild — use a stable identity once this ships.
set -e
cd "$(dirname "$0")"
swiftc -O -parse-as-library -target arm64-apple-macos26.0 voiced.swift -o voiced
echo "built native/voiced"
