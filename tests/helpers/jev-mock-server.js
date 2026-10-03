#!/usr/bin/env node
'use strict';
// jev-mock-server.js — a Jev "systemone" mock endpoint that runs as its OWN
// process, not inside the test process.
//
// WHY A SEPARATE PROCESS (not an in-process http.createServer like
// tests/hooks/jev-assist.test.js uses): that in-process pattern only works
// for ask()/askSync() called DIRECTLY in-process (jev-assist.test.js) or via
// an ASYNC `spawn` child (its own runAskSyncInChild helper — the test
// process's event loop stays live while awaiting the child).
//
// tests/helpers/spawn-hook.js's testHook(), by contrast, spawns the HOOK
// itself via spawnSync — which BLOCKS the test process's event loop for the
// hook's entire lifetime. If that hook then calls askSync() (git-guard.js's
// gitGuardSelfCredit consult), askSync spawns a THIRD process
// (jev-assist-worker.js) that tries to fetch an in-process mock server
// living in the (now-blocked) test process — a real deadlock, reproduced and
// confirmed while building the gitGuardSelfCredit integration (the mock
// server's request handler never fires; the call always times out at
// exactly its budget). Running the mock endpoint in ITS OWN process sidesteps
// this entirely: it keeps its own event loop regardless of what the test
// process's spawnSync chain is doing.
//
// Contract: env ANTIHALL_MOCK_NOUL ('0.95' etc, the noul confidence value
// jev-client.js's noul math reads as answer=(noul>=0.5)) configures every
// response. Prints "PORT=<n>\n" to stdout once listening, then serves.
const http = require('http');

const noul = Number(process.env.ANTIHALL_MOCK_NOUL);
const value = Number.isFinite(noul) ? noul : 0.05; // default: confident "false"

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answers: { decision: { noul: value } } }));
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
