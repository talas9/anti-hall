'use strict';
// stub-judge-https.js — a NODE_OPTIONS=--require PRELOAD fixture for
// speculation-judge tests. It replaces https.request so NO network call is made:
// the request body is appended (one JSON line) to ANTIHALL_TEST_JUDGE_LOG and a
// canned Messages-API reply is returned. ANTIHALL_TEST_JUDGE_REPLY is the judge
// JSON the "model" answers with, e.g. {"decision":"allow"}.

const https = require('https');
const fs = require('fs');
const { EventEmitter } = require('events');

https.request = function stubRequest(_options, cb) {
  const req = new EventEmitter();
  let body = '';
  req.write = (chunk) => { body += chunk; };
  req.destroy = () => {};
  req.end = () => {
    try { fs.appendFileSync(process.env.ANTIHALL_TEST_JUDGE_LOG, body + '\n'); } catch (_) { /* ignore */ }
    const res = new EventEmitter();
    if (cb) cb(res);
    const reply = process.env.ANTIHALL_TEST_JUDGE_REPLY || '{"decision":"allow"}';
    setImmediate(() => {
      res.emit('data', JSON.stringify({ content: [{ type: 'text', text: reply }] }));
      res.emit('end');
      req.emit('close');
    });
  };
  return req;
};
