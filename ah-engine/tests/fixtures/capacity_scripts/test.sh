#!/bin/sh
set -e
cargo test --workspace
npm test
