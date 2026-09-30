// Hard boundary for omega_batch, added 2026-09-27.
//
// MCP tool calls are permission-evaluated under their own action name -- the log
// shows permission=omega_omega_batch, entirely separate from permission=bash.
// So a subagent configured with `shell: deny` and `edit: deny` could still write
// anywhere through a batch step, which made "cannot modify files" a promise in a
// system prompt rather than an enforced boundary. This module makes it one.
//
// Scope is deliberately narrow: only explicit content-write channels are refused,
// namely output redirection, tee and dd of=. Writes under /tmp and to /dev/null
// stay allowed so scratch files and silenced output keep working. Note that rm,
// mv and chmod are NOT covered -- this guards against writing content, not
// against destroying it.
//
// This is defence in depth, not a sandbox: the caller can always reach a real
// shell. Its job is to make "I will not write outside /tmp" mechanically true
// for the shapes an agent actually emits, so that a subagent whose shell is
// denied still cannot spill content through a batch step.

import nodePath from 'node:path';
import { realpathSync } from 'node:fs';

// A > inside quotes is data, not a redirection, so blank quoted spans first.
function unquote(s) {
  return String(s == null ? '' : s)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

// Resolve through symlinks. A prefix check on the literal string cannot see that
// `/tmp/link` is a symlink to `/etc/passwd`, so `echo x > /tmp/link` sailed
// through and landed outside. Walk up to the nearest existing ancestor, ask the
// filesystem what it really is, and re-attach the not-yet-created tail.
function realTarget(t) {
  let p = t;
  const tail = [];
  for (let i = 0; i < 40; i++) {
    try {
      return tail.length ? nodePath.join(realpathSync(p), ...tail) : realpathSync(p);
    } catch {
      const parent = nodePath.dirname(p);
      if (parent === p) return t;
      tail.unshift(nodePath.basename(p));
      p = parent;
    }
  }
  return t;
}

// The allowlist is prefix-based, so `/tmp/../etc/passwd` matched `/tmp/\S*` and
// wrote outside /tmp. Normalize first, then decide: resolve against / so an
// absolute target collapses to its real location, and keep $TMPDIR-style
// targets unresolved (they are only legal as themselves).
function targetAllowed(t) {
  // A $TMPDIR target is legal only if every segment is a plain name. `[^/]+`
  // alone is not enough: it happily matches `..`, so `$TMPDIR/../etc/x` passed
  // the old `$TMPDIR\S*` tail and again here. Reject dot-segments outright.
  if (/^\$/.test(t)) {
    const rest = t.replace(/^\$\{?TMPDIR\}?/, '');
    if (rest === '') return true;
    if (!rest.startsWith('/')) return false;
    return rest.split('/').slice(1).every((seg) => seg && seg !== '.' && seg !== '..');
  }
  if (!t.startsWith('/')) return false;
  const real = nodePath.resolve('/', realTarget(t));
  return /^\/(dev\/(null|stdout|stderr)|tmp\/|private\/tmp\/)/.test(real);
}

// Find every `>` that really is a redirection and return its target.
//
// The old regex was `/(?:^|[^0-9&>])>>?\s*(\S+)/g`. The [^0-9&>] guard existed so
// that `2>&1` and `&>` would not be mis-read, but as a left boundary it also
// skipped `2>file`, `3>file` and `&>file` -- the numeric-fd and both-streams
// forms, which are exactly the shapes a real escape uses. So parse instead: a
// `>` is a redirection when it is not preceded by `<`, and its target is the
// next non-space run. An fd number may sit between the operator and the target
// (`2>file`, `2>>file`); `>&1` and `&>file` are handled by the same scan.
function redirectTargets(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '>' || s[i - 1] === '<') continue;
    let j = i + 1;
    if (s[j] === '>') j++;
    // `>&1` and `>&-` duplicate or close a descriptor and name no file. But
    // bash reads `>&word` for ANY other word as the `&>word` shorthand for
    // "both streams", so `>&/etc/x` really does write /etc/x. Only treat it as a
    // descriptor op when a digit or `-` follows.
    if (s[j] === '&') {
      const nx = s[j + 1];
      if (nx === undefined || /[\s\d-]/.test(nx)) continue;
      j++;
    }
    while (j < s.length && /\s/.test(s[j])) j++;
    // Skip a leading fd number: `2>file` parses as > then "2" then target.
    const num = /^\d+/.exec(s.slice(j));
    if (num) j += num[0].length;
    const t = /^\S+/.exec(s.slice(j));
    if (t) out.push(t[0]);
  }
  return out;
}

// `>` inside quotes is invisible to the redirect scan because unquote() blanks
// it -- correct for `echo "a > b"`, wrong when the quoted string is CODE handed
// to something that interprets it. `eval "echo x > /etc/x"` and
// `awk '{print > "/etc/x"}' /etc/hosts` both wrote outside /tmp. When an
// interpreter is present, a quoted `>` is a live redirection, not data.
//
// But not every `>` in code is a redirection, and treating all of them as one
// made the guard refuse honest work: `node -e "items.map(x => x)"` was refused
// for the arrow's `>`, and so was any `2>/dev/null` buried in a string. So the
// quoted body is unwrapped and parsed like shell, and only a target that looks
// like a FILENAME is judged -- `=>` and `a > b` (a JS/shell comparison with a
// bare operand) are operators, not redirections.
const INTERPRETER = /\b(eval|exec|source|bash|sh|zsh|ksh|dash|awk|gawk|mawk|nawk|sed|perl|ruby|php|python3?|node|deno|bun|xargs|env|nice|nohup|setsid|timeout|sudo|command)\b/;

// Only a path-shaped target can name a file, so this is what separates a real
// redirect from a code operator: `1>0`, `x > y` and the `>` of `=>` all have a
// bare operand and stay legal, while `> /etc/x`, `> "$TMPDIR/f"` and `> ~/f`
// name a real file and must be judged. No left-operand inspection needed.
const PATH_LIKE = /^(\/|~|\$)/;

function quotedFileRedirects(body) {
  const hits = [];
  // Unwrap nested quotes first: awk's `'{print > "/etc/x"}'` carries its target
  // in a second layer of quotes that the outer scan would otherwise see as one
  // opaque token starting with a quote character.
  const inner = expandRedirectQuotes(String(body));
  for (const t of redirectTargets(inner)) {
    if (t.startsWith('&')) continue;
    if (!PATH_LIKE.test(t)) continue;
    hits.push(t);
  }
  return hits;
}

function quotedRedirects(s) {
  const hits = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const body = m[1] !== undefined ? m[1] : m[2];
    if (/[<>]/.test(body)) hits.push(body);
  }
  return hits;
}

// `> "/etc/x"` and `> '$TMPDIR/f'` are real redirections, but unquote() blanks
// the span first, so the scan only ever saw an empty target and refused with a
// useless "redirects into ''" -- failing safe, but rejecting legitimate work.
// Unwrap a quoted span only when it sits directly behind a `>` operator, so
// `echo "a > b"` keeps its `>` as data.
function expandRedirectQuotes(s) {
  return String(s).replace(/>\s*(?:'([^']*)'|"([^"]*)")/g, (all, a, b) => '>' + (a !== undefined ? a : b));
}

export function inspectCommand(cmd) {
  const problems = [];
  const raw = String(cmd == null ? '' : cmd);
  const s = unquote(expandRedirectQuotes(raw));
  let m;

  for (const t of redirectTargets(s)) {
    // `>&1` / `2>&1` duplicate a descriptor, they do not name a file.
    if (t.startsWith('&')) continue;
    if (!targetAllowed(t)) problems.push('redirects into ' + t);
  }

  // Interpreter + quoted `>`: the redirect only exists once the string is run.
  // Judge each path-shaped target on its own merits instead of refusing the
  // whole string, so `node -e "... => ..."` and a buried `2>/dev/null` pass.
  if (INTERPRETER.test(raw)) {
    for (const body of quotedRedirects(raw)) {
      for (const t of quotedFileRedirects(body)) {
        if (!targetAllowed(t)) {
          problems.push(`redirect hidden inside a quoted string handed to an interpreter: ${t}`);
          break;
        }
      }
      if (problems.length) break;
    }
  }

  // A symlink whose target sits outside /tmp turns every later `/tmp/...`
  // redirect into an escape, so refuse to build one in the first place. A
  // relative target is judged against the link's own directory, because that is
  // how the kernel will read it back.
  const ln = /\bln\b((?:\s+-\S+)*)\s+(\S+)(?:\s+(\S+))?/g;
  while ((m = ln.exec(s)) !== null) {
    let operand = m[2];
    if (operand.startsWith('-')) continue; // flags only, no path operand
    if (!operand.startsWith('/')) {
      const linkPath = m[3] && !m[3].startsWith('-') ? m[3] : '/tmp/link';
      const base = linkPath.startsWith('/') ? nodePath.dirname(linkPath) : '/tmp';
      operand = nodePath.resolve(base, operand);
    }
    if (!targetAllowed(operand)) problems.push('symlink pointing outside /tmp at ' + operand);
  }

  const tee = /\btee\b\s+(?:-a\s+)?(\S+)/g;
  while ((m = tee.exec(s)) !== null) {
    if (!targetAllowed(m[1])) problems.push('writes ' + m[1] + ' via tee');
  }

  const dd = /\bdd\b[^;|&]*?\bof=(\S+)/g;
  while ((m = dd.exec(s)) !== null) {
    if (!targetAllowed(m[1])) problems.push('writes ' + m[1] + ' via dd');
  }

  return { ok: problems.length === 0, problems };
}

export function guardSteps(steps) {
  const bad = [];
  (steps || []).forEach((st, i) => {
    const r = inspectCommand(st && st.command_line);
    if (!r.ok) bad.push('  step ' + (i + 1) + ': ' + r.problems.join('; '));
  });
  if (!bad.length) return null;
  return [
    'refused: omega_batch will not write files outside /tmp.',
    bad.join('\n'),
    'Use the builtin write or edit tool for file content: it takes the content as a',
    'parameter so there is no shell quoting to get wrong, it shows a diff, and it is',
    'covered by edit permissions. If you only need scratch output, redirect into /tmp',
    'or /dev/null instead.',
  ].join('\n');
}
