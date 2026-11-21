#!/usr/bin/env bash
# a variable made by mktemp and then set to something else is no own path
tmp=$(mktemp -d)
tmp=$HOME
rm -rf "$tmp"
