#!/usr/bin/env bash
# Compile le coeur en wasm32 et genere le lien JS (wasm-bindgen --target web).
# Prerequis (espace utilisateur) :
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.130 --locked
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --remove-name-section --remove-producers-section --out-dir pkg target/wasm32-unknown-unknown/release/savoire_core.wasm

# Paquets JS pris dans frontend/node_modules (pnpm), sans installation.
FE=${FE:-../../frontend/node_modules}  # ou FE=/chemin/vers/Savoire/frontend/node_modules
mkdir -p node_modules/@codemirror
for p in yjs lib0 y-codemirror.next; do ln -sfn "$(realpath $FE/.pnpm/node_modules/$p)" node_modules/$p; done
for p in state view commands; do ln -sfn "$(realpath $FE/.pnpm/node_modules/@codemirror/$p)" node_modules/@codemirror/$p; done
ln -sfn "$(realpath $FE/happy-dom)" node_modules/happy-dom
echo "ok : pkg/savoire_core_bg.wasm"
