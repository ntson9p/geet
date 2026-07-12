// GIT_SEQUENCE_EDITOR shim (P5-T1): git invokes it with the path of the
// generated rebase todo file; we replace that file with the plan GitTree
// serialized up front. The plan file path is baked into the editor command
// string, so argv is [node, shim, planfile, todofile]. Runs under the
// VS Code Electron binary with ELECTRON_RUN_AS_NODE=1 (or plain node).
// Any failure exits non-zero, which makes git abort the rebase cleanly.
'use strict';
const fs = require('fs');

const planFile = process.argv[2];
const todoFile = process.argv[3];

if (!planFile || !todoFile) {
  process.stderr.write('gittree-seq-editor: expected <planfile> <todofile> argv\n');
  process.exit(1);
}

try {
  fs.copyFileSync(planFile, todoFile);
} catch (err) {
  process.stderr.write('gittree-seq-editor: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
}
process.exit(0);
