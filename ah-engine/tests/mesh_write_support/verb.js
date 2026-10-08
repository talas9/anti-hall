'use strict';
// Runs ONE devswarm.js verb the way `node scripts/devswarm.js <argv>` does (same run(), same main() rendering), with
// Date.now() pinned by AH_ENGINE_MESH_NOW_MS (ctx.now), and prints {"code", "stdout"} as JSON on fd 1.
// usage: AH_ENGINE_MESH_NOW_MS=<ms> node verb.js <argv...>   (HOME and cwd are the caller's: run it in a scratch home)
const path = require('path');
const os = require('os');
const cli = require(path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js'));
if (os.homedir() === require('os').userInfo().homedir) { process.stderr.write('refusing: HOME is the real home\n'); process.exit(2); }
const argv = process.argv.slice(2);
const now = Number(process.env.AH_ENGINE_MESH_NOW_MS);
const { code, result } = cli.run(argv, Number.isFinite(now) ? { now } : {});
const isSendQuiet = argv[0] === 'send' && argv.includes('--quiet');
const isTickQuiet = argv[0] === 'inbox' && argv[1] === 'tick' && argv.includes('--quiet');
const human = !argv.includes('--json');
const isReadPrimaryText = argv[0] === 'inbox' && argv[1] === 'read-primary' && (argv.includes('--format=text') || (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'text'));
const isRosterText = argv[0] === 'roster' && !argv.includes('--ack') && !!result && result.ok === true && result.action === 'roster';
const rosterText = () => require(path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm-lib', 'roster-diag.js')).rosterHumanText(result, { all: argv.includes('--all'), home: os.homedir(), now: Date.now() });
const out = isRosterText && human ? rosterText() : isSendQuiet && human ? cli.sendQuietLine(result) : (isTickQuiet && human ? cli.inboxTickQuietLine(result) : (isReadPrimaryText && human ? cli.inboxReadPrimaryTextLines(result) : JSON.stringify(result)));
process.stdout.write(JSON.stringify({ code, stdout: out + '\n' }) + '\n');
