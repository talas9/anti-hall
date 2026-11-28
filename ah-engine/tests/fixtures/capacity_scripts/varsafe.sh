#!/bin/sh
# a variable in command position with plain arguments
CC=cc
$CC -o x x.c
"$RUNNER" test --quiet
