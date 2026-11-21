// GIT_ASKPASS shim (master §4 credentials): forwards git's prompt to the
// Geet extension over a token-authenticated named pipe / unix socket and
// prints the answer on stdout. Runs under the VS Code Electron binary with
// ELECTRON_RUN_AS_NODE=1 (or plain node). No dependencies, CJS on purpose.
'use strict';
const net = require('net');

const pipe = process.env.GEET_ASKPASS_PIPE;
const token = process.env.GEET_ASKPASS_TOKEN;
// git invokes: <askpass> 'Username for <https://host>: '
const prompt = process.argv[process.argv.length - 1] || '';

if (!pipe || !token) {
  process.stderr.write('geet-askpass: missing pipe/token env\n');
  process.exit(1);
}

const socket = net.connect(pipe);
socket.setEncoding('utf8');

let buffer = '';
let done = false;

const fail = (msg) => {
  if (done) return;
  done = true;
  if (msg) process.stderr.write('geet-askpass: ' + msg + '\n');
  try {
    socket.destroy();
  } catch {}
  process.exit(1);
};

socket.on('connect', () => {
  socket.write(JSON.stringify({ v: 1, token: token, prompt: prompt }) + '\n');
});

socket.on('data', (chunk) => {
  buffer += chunk;
  const idx = buffer.indexOf('\n');
  if (idx === -1) return;
  let response;
  try {
    response = JSON.parse(buffer.slice(0, idx));
  } catch {
    return fail('bad response');
  }
  if (done) return;
  if (response && response.ok === true && typeof response.value === 'string') {
    done = true;
    process.stdout.write(response.value + '\n');
    socket.end();
    process.exit(0);
  } else {
    fail(response && response.error ? String(response.error) : 'denied');
  }
});

socket.on('error', (err) => fail(err && err.message));
socket.on('close', () => fail());

// Safety net: never wedge git forever if the extension host went away.
setTimeout(() => fail('timeout'), 10 * 60 * 1000).unref();
