'use strict';
// Test support: Node's own distinctRepoKeys over the descriptors readDescriptors reads. usage: node distinct.js <root> <home>
const path = require('path');
const [root, home] = process.argv.slice(2);
process.env.HOME = home;
const S = require(path.join(root, 'companion', 'devswarm-supervisor.js'));
process.stdout.write(JSON.stringify(S.distinctRepoKeys(S.readDescriptors(home))) + '\n');
