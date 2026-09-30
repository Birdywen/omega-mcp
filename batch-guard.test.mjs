// Regression suite for the omega MCP guard and tool surfaces.
//
// Every case here is a bug that actually shipped. The REFUSE list is the
// important half: a guard that refuses honest work gets routed around, which
// costs more than the escape it prevents. The ALLOW list pins the 2026-09-28
// false positive where `node -e "... => ..."` was read as a redirection.
//
// Run: node mcp/batch-guard.test.js
import { inspectCommand, guardSteps } from './batch-guard.mjs';

let pass = 0;
const failures = [];

function mustRefuse(cmd, why) {
  const r = inspectCommand(cmd);
  if (r.ok) failures.push(`EXPECTED REFUSE but allowed: ${cmd}\n    reason: ${why}`);
  else pass++;
}

function mustAllow(cmd, why) {
  const r = inspectCommand(cmd);
  if (!r.ok) failures.push(`EXPECTED ALLOW but refused: ${cmd}\n    reason: ${why}\n    guard said: ${r.problems.join('; ')}`);
  else pass++;
}

// ---- direct redirects -------------------------------------------------
mustRefuse('echo x > /etc/passwd', 'plain absolute redirect');
mustRefuse('echo x > /etc/x', 'absolute outside /tmp');
mustRefuse('echo x >/etc/x', 'no space after >');
mustRefuse('echo x >> /etc/x', 'append form');
mustRefuse('echo x 2> /etc/x', 'numeric fd form (old regex skipped this)');
mustRefuse('echo x 3>>/etc/x', 'numeric fd append form');
mustRefuse('echo x &> /etc/x', 'both-streams form');
mustRefuse('echo x >&/etc/x', '>&word is the &> shorthand in bash');
mustRefuse('echo x > /tmp/../etc/passwd', 'dot-dot escape through the /tmp allowlist');
mustRefuse('echo x > /tmp/a/../../etc/x', 'two-level escape (macOS /tmp is a symlink)');
mustRefuse('echo x > "$TMPDIR/../etc/x"', '$TMPDIR with a dot-dot segment');
mustAllow('echo x > "$TMPDIR"', 'bare $TMPDIR is allowed');
mustAllow('echo x > "$TMPDIR/f.txt"', 'plain name under $TMPDIR');
mustAllow('echo x > /tmp/f', 'tmp is allowed');
mustAllow('echo x > /dev/null', 'dev/null is allowed');
mustAllow('echo x 2>/dev/null', 'fd redirect to /dev/null');
mustAllow('echo "a > b"', 'quoted > is data, not a redirect');
mustAllow('cat /etc/hosts | head -3', 'no write at all');
mustAllow('grep -r foo . ', 'read only');

// ---- redirect behind a quoted span -----------------------------------
mustRefuse('echo x > "/etc/y"', 'quoted target must report the real name');
mustRefuse("echo x > '/etc/y'", 'single-quoted target');
mustAllow('echo "a > b" | cat', 'quoted data stays data even with > inside');

// ---- interpreter + quoted code (the 2026-09-28 false positives) ------
mustAllow('node -e "items.map(x => x)"', 'arrow function is not a redirection');
mustAllow('node --input-type=module -e "const f = a => a + 1; console.log(f(1))"', 'arrow with body');
mustAllow('python3 -c "print(sum(x for x in range(3)))"', 'generator expression, no >');
mustAllow('node -e "console.log(1 > 0)"', 'numeric comparison in code');
mustAllow('node -e "process.stderr.write(String(2 > 1))" 2>/dev/null', 'fd redirect to /dev/null inside a string');
mustAllow("bash -c 'echo hi > /dev/null'", 'redirect to /dev/null inside an interpreter string');
mustRefuse('eval "echo x > /etc/x"', 'hidden redirect through eval');
mustRefuse('bash -c "echo x > /etc/x"', 'hidden redirect through bash -c');
mustRefuse("awk '{print > \"/etc/x\"}' /etc/hosts", 'awk print > file, nested quotes');
mustRefuse('eval "echo x > /tmp/../etc/x"', 'hidden redirect with dot-dot');
mustAllow("awk '{print $1}' /etc/hosts", 'awk field ref, no redirect');

// ---- symlinks and helpers --------------------------------------------
mustRefuse('ln -s /etc/passwd /tmp/link', 'symlink out of /tmp');
mustRefuse('ln -s /etc /tmp/dirlink', 'symlinked directory out of /tmp');
mustAllow('ln -s /tmp/real /tmp/link', 'symlink inside /tmp');
mustRefuse('echo x | tee /etc/x', 'tee outside /tmp');
mustAllow('echo x | tee /tmp/x', 'tee inside /tmp');
mustRefuse('dd if=/dev/zero of=/etc/x', 'dd of= outside /tmp');
mustAllow('dd if=/dev/zero of=/tmp/x bs=1M count=1', 'dd of= inside /tmp');

// ---- guardSteps wrapping ---------------------------------------------
const bad = guardSteps([{ command_line: 'echo ok' }, { command_line: 'echo x > /etc/x' }]);
if (!bad || !bad.includes('step 2')) failures.push('guardSteps must name the offending step number');
else pass++;
if (guardSteps([{ command_line: 'echo ok > /tmp/x' }]) !== null) failures.push('guardSteps must return null for a clean batch');
else pass++;
if (guardSteps(null) !== null) failures.push('guardSteps must tolerate a null steps array');
else pass++;

// ---- report ----------------------------------------------------------
console.log(`batch-guard: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}
