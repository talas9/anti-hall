#!/usr/bin/env node
'use strict';
// jev-hang-server.js — a Jev endpoint that ACCEPTS every connection and NEVER
// responds (no timeout, no close), for R7A1-1's total-Jev-time-budget repro.
// Runs as its OWN process for the same reason jev-mock-server.js does (see
// that file's header): testHook() spawns the hook via spawnSync, which blocks
// the test process's event loop for the hook's whole lifetime, so an
// in-process mock server would deadlock against the hook's own subprocess
// fetch. Prints "PORT=<n>\n" to stdout once listening.
const http = require('http');

const server = http.createServer((req, _res) => {
  // Deliberately never call res.end()/res.writeHead() and never destroy the
  // socket: the request just hangs until the CLIENT's own timeout fires.
  req.resume();
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
