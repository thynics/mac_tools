#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QA_DIR="${1:-$(mktemp -d -t biweekly-qa)}"
mkdir -p "$QA_DIR"
"$ROOT/scripts/build.sh"
TEST_APP="$QA_DIR/BiweeklyTest.app"
ditto "$ROOT/build/Biweekly.app" "$TEST_APP"
xcrun swiftc -D UI_TESTS -target "$(uname -m)-apple-macosx13.0" -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers "$ROOT"/Sources/*.swift "$ROOT/tests/native.swift" -o "$TEST_APP/Contents/MacOS/Biweekly"
codesign --force --deep --sign - "$TEST_APP"
NATIVE_TEST_OUTPUT="$QA_DIR" "$TEST_APP/Contents/MacOS/Biweekly" --data-dir "$QA_DIR/store"
NATIVE_TEST_OUTPUT="$QA_DIR" "$TEST_APP/Contents/MacOS/Biweekly" --data-dir "$QA_DIR/store" --readback
printf '{invalid-json' > "$QA_DIR/store/data.json"
NATIVE_TEST_OUTPUT="$QA_DIR" "$TEST_APP/Contents/MacOS/Biweekly" --data-dir "$QA_DIR/store" --readback
printf 'Native test results (including corruption recovery): %s\n' "$QA_DIR"
