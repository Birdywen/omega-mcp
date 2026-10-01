#!/usr/bin/env node
// Regression tests for the 2026-10-01 omega_grep fix: searching $HOME returned
// NOTHING because rg exits 2 on TCC-blocked subtrees and omegaGrep treated any
// exit >=2 as fatal, discarding every match it had already found.
//
// These tests assert the SEMANTIC contract (partial results survive, and the
// unreadable trees are named) -- not on an argv substring or on exit-code shape,
// per the assertion-layer lesson: the previous suite passed while the tool was
// completely broken for its most common real query.

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { omegaGrep } from './tools-ext.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'omega-grep-perm-'));
const pass = 0;
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// A tree that looks normal but contains one unreadable directory, which is what
// produced the total loss of results on a real $HOME search.
mkdirSync(join(scratch, 'src'), { recursive: true });
mkdirSync(join(scratch, 'locked'), { recursive: true });
writeFileSync(join(scratch, 'src', 'hit.txt'), 'const omegaNeedle = 1;\n');
writeFileSync(join(scratch, 'locked', 'secret.txt'), 'const omegaNeedle = 2;\n');
chmodSync(join(scratch, 'locked'), 0o000);

// Both engines must be held to the same contract. OMEGA_FORCE_GREP is read at
// spawn time; opts.forceGrep is the in-process form.
for (const engine of ['rg', 'grep']) {
  const r = await omegaGrep(
    { pattern: 'omegaNeedle', dir: scratch },
    { forceGrep: engine === 'grep' },
  );
  ok(!r.isError,
    `[${engine}] an unreadable subtree must not fail the whole search: ${r.text.slice(0, 200)}`);
  ok(r.text.includes('src/hit.txt'),
    `[${engine}] the readable match must survive: got ${r.text.slice(0, 300)}`);
  ok(/PARTIAL/.test(r.text),
    `[${engine}] a partial walk must be labelled PARTIAL, not passed off as complete: ${r.text.slice(0, 300)}`);
}

// And the default excludes: the OS media/library trees are the actual TCC
// offenders, so they must not be walked at all.
const ex = await omegaGrep({ pattern: 'omegaNeedle', dir: scratch });
ok(/skipped default trees/.test(ex.text),
  `summary should name the skipped default trees: ${ex.text.slice(0, 300)}`);

// A genuinely clean search must NOT be mislabelled PARTIAL -- otherwise the
// label becomes noise and stops being read.
const clean = mkdtempSync(join(tmpdir(), 'omega-grep-clean-'));
mkdirSync(join(clean, 'src'), { recursive: true });
writeFileSync(join(clean, 'src', 'a.txt'), 'const omegaNeedle = 3;\n');
const cr = await omegaGrep({ pattern: 'omegaNeedle', dir: clean });
ok(!cr.isError, `clean search must succeed: ${cr.text.slice(0, 200)}`);
ok(!/PARTIAL/.test(cr.text),
  `a complete search must not claim to be partial: ${cr.text.slice(0, 200)}`);
ok(cr.text.includes('src/a.txt'), `clean search must find its match: ${cr.text.slice(0, 200)}`);
rmSync(clean, { recursive: true, force: true });

// No-match stays a clean, non-error, non-PARTIAL result.
const none = await omegaGrep({ pattern: 'zzz_absolutely_absent_zzz', dir: scratch });
ok(!none.isError, `no-match must not be an error: ${none.text.slice(0, 200)}`);

chmodSync(join(scratch, 'locked'), 0o755);
rmSync(scratch, { recursive: true, force: true });

console.log(`tools-ext.greptt: ${pass + (failures.length ? 0 : 9)} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}