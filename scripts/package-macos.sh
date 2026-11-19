#!/usr/bin/env bash
# WSL: stage the release UI, worker and target's Node first. Put clang, llvm-ar
# and rcodesign on PATH, export SDKROOT, then run this script for each target.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  x86_64|aarch64) export mac_target="$1-apple-darwin" ;;
  *) echo "Usage: $0 {x86_64|aarch64}" >&2; exit 2 ;;
esac
: "${SDKROOT:?Set SDKROOT to an extracted macOS SDK}"
test -f "$SDKROOT/usr/lib/libSystem.tbd"
export MACOSX_DEPLOYMENT_TARGET=13.5
export CARGO_TARGET_DIR="$(realpath -m "${CARGO_TARGET_DIR:-src-tauri/target}")"
export mac_linker="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/gcc-ld/ld64.lld"
mkdir -p "$CARGO_TARGET_DIR/$mac_target"
wrapper="$CARGO_TARGET_DIR/$mac_target/clang"
cat > "$wrapper" <<'CLANG'
#!/bin/sh
exec clang --target="$mac_target" -isysroot "$SDKROOT" -mlinker-version=711 -fuse-ld="$mac_linker" "$@"
CLANG
chmod +x "$wrapper"
var=${mac_target//-/_}
export "CC_$var=$wrapper" "AR_$var=llvm-ar" "CARGO_TARGET_${var^^}_LINKER=$wrapper"
cargo build --release --locked --manifest-path src-tauri/Cargo.toml --features custom-protocol --target "$mac_target"
python3 scripts/package-macos.py "$1" "$CARGO_TARGET_DIR/$mac_target/release"
