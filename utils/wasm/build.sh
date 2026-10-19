#!/bin/sh
set -eu
cargo build --target wasm32-unknown-unknown --release --locked
mkdir -p static
mkdir -p static/assets
cp -r assets/. static/assets/
cp target/wasm32-unknown-unknown/release/zemeroth.wasm static/
cp utils/wasm/index.html utils/wasm/gl.js utils/wasm/audio.js utils/wasm/skirmish.css utils/wasm/skirmish.js static/
