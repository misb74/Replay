#!/bin/zsh
set -euo pipefail

capture_dir=${0:A:h:h}
developer_dir=${DEVELOPER_DIR:-$(xcode-select -p)}
developer_frameworks="$developer_dir/Library/Developer/Frameworks"

cd "$capture_dir"

if [[ -d "$developer_frameworks/Testing.framework" ]]; then
  swift test \
    --disable-sandbox \
    --enable-swift-testing \
    --disable-xctest \
    -Xswiftc -F \
    -Xswiftc "$developer_frameworks" \
    -Xswiftc -Xfrontend \
    -Xswiftc -disable-cross-import-overlays \
    -Xlinker -rpath \
    -Xlinker "$developer_frameworks"
else
  swift test --disable-sandbox
fi
