#!/bin/zsh
set -eu
cd "${0:A:h}"
sdk_path=$(xcrun --sdk macosx --show-sdk-path)
xcrun clang -fobjc-arc -dynamiclib -target arm64-apple-ios13.1-macabi \
  -isysroot "$sdk_path" -F "$sdk_path/System/iOSSupport/System/Library/Frameworks" \
  -framework Foundation -framework CFNetwork -framework SystemConfiguration \
  -O2 -Wall -Wextra -Wno-unused-parameter PlayCoverDirect.m -o PlayCoverDirect.dylib
codesign --force --sign - PlayCoverDirect.dylib
