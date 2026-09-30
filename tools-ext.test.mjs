// Regression suite for the omega tool surfaces that are not the guard: argument
// validation, edit commit semantics, and the write fences added 2026-09-28.
// Runs against the real modules with a temp scratch dir; touches no real file
// and no real database row.
//
// Run: node mcp/tools-ext.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectCommand } from './batch-guard.mjs';
import {
  vfsLocalWrite, omegaBatch, omegaBatchStatus, omegaBatchCancel,
  omegaEdit, omegaUndo, omegaRead, omegaGrep, dbQuery, EXTRA_TOOLS,
} from './tools-ext.mjs';

let pass = 0;
const failures = [];
const ok = (cond, label) => { if (cond) pass++; else failures.push(label); };
const scratch = mkdtempSync(path.join(tmpdir(), 'omega-tools-test-'));

// ---- omega_batch: structured status, failure classes, and cancellation ----
{
  const started = await omegaBatch({ steps: [
    { label: 'accepted', command_line: 'unused', expect: { contains: ['TOKEN'] } },
  ] }, async () => ({ isError: false, text: 'TOKEN\n' }));
  const id = /batch started: (job-[a-z0-9-]+)/.exec(started.text)?.[1];
  const status = await omegaBatchStatus({ id, waitMs: 1000, format: 'json' });
  const parsed = JSON.parse(status.text);
  ok(!status.isError && parsed.state === 'success', 'omega_batch JSON status must report success');
  ok(parsed.results[0].status === 'passed' && parsed.results[0].failureType === null, 'omega_batch JSON status must expose structured step fields');

  const partialStart = await omegaBatch({ stopOnError: false, steps: [
    { label: 'bad assertion', command_line: 'unused', expect: { contains: ['MISSING_TOKEN'] } },
    { label: 'continues', command_line: 'unused' },
  ] }, async () => ({ isError: false, text: 'ordinary output' }));
  const partialId = /batch started: (job-[a-z0-9-]+)/.exec(partialStart.text)?.[1];
  const partialStatus = await omegaBatchStatus({ id: partialId, waitMs: 1000, format: 'json' });
  const partial = JSON.parse(partialStatus.text);
  ok(partialStatus.isError && partial.state === 'partial', 'a continued batch with a failed step must still return isError');
  ok(partial.results[0].failureType === 'expectation' && partial.results[1].status === 'passed', 'omega_batch must classify expectations and continue when requested');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancelStart = await omegaBatch({ steps: [
    { label: 'active', command_line: 'unused' },
    { label: 'must not start', command_line: 'unused' },
  ] }, async () => gate);
  const cancelId = /batch started: (job-[a-z0-9-]+)/.exec(cancelStart.text)?.[1];
  const cancel = omegaBatchCancel({ id: cancelId });
  release({ isError: false, text: 'active finished' });
  const cancelledStatus = await omegaBatchStatus({ id: cancelId, waitMs: 1000, format: 'json' });
  const cancelled = JSON.parse(cancelledStatus.text);
  ok(!cancel.isError && cancelled.state === 'cancelled', 'omega_batch_cancel must move a running job to cancelled after the active step');
  ok(cancelled.done === 1 && cancelled.results.some((r) => r.failureType === 'cancelled'), 'omega_batch_cancel must prevent later steps from starting');
}

// ---- vfs_local_write: byte safety, atomic replacement, and preconditions ----
{
  const binary = path.join(scratch, 'binary.bin');
  const bytes = Buffer.from([0, 255, 1, 128, 10]);
  const r = vfsLocalWrite({ path: binary, content_b64: bytes.toString('base64'), requireMissing: true });
  ok(!r.isError && readFileSync(binary).equals(bytes), 'vfs content_b64 must remain byte-exact: ' + r.text);
  const ambiguous = vfsLocalWrite({ path: binary, content: 'x', content_b64: 'eA==' });
  ok(ambiguous.isError, 'vfs must reject multiple content sources');
  const collision = vfsLocalWrite({ path: binary, content: 'replace', requireMissing: true });
  ok(collision.isError && readFileSync(binary).equals(bytes), 'vfs requireMissing must preserve an existing target');
  const wrongHash = vfsLocalWrite({ path: binary, content: 'replace', expectedSha256: '0'.repeat(64) });
  ok(wrongHash.isError && readFileSync(binary).equals(bytes), 'vfs expectedSha256 mismatch must preserve the target');
  const correctHash = createHash('sha256').update(bytes).digest('hex');
  const replaced = vfsLocalWrite({ path: binary, content: 'text', expectedSha256: correctHash });
  ok(!replaced.isError && readFileSync(binary, 'utf8') === 'text', 'vfs matching expectedSha256 must replace atomically');
}

// ---- omega_edit: same-file chaining (the 2026-09-28 correctness fix) ----
// Each oldString must stay unique ACROSS the whole file, including the text an
// earlier edit produced, or the ambiguity check (correctly) refuses. Using
// distinct tokens proves the second edit really reads the first edit's output.
{
  const f = path.join(scratch, 'chain.txt');
  writeFileSync(f, 'one\ntwo\nthree\n');
  const r = omegaEdit({ edits: [
    { path: f, oldString: 'one', newString: 'ONE' },
    { path: f, oldString: 'two', newString: 'TWO-CHAINED' },
  ] });
  ok(!r.isError, 'chained same-file edits must succeed: ' + r.text);
  ok(readFileSync(f, 'utf8') === 'ONE\nTWO-CHAINED\nthree\n',
    'both edits must survive, later one seeing the earlier: got ' + JSON.stringify(readFileSync(f, 'utf8')));
  ok(/@@ lines/.test(r.text), 'result must carry a hunk diff');
}

// ---- omega_edit: encoding, line endings, mode, regex and final assertions ----
{
  const invalidUtf8 = path.join(scratch, 'invalid-utf8.txt');
  const invalidBytes = Buffer.from([0xff, 0xfe, 0x41]);
  writeFileSync(invalidUtf8, invalidBytes);
  const invalid = omegaEdit({ edits: [{ path: invalidUtf8, oldString: 'A', newString: 'B' }] });
  ok(invalid.isError && readFileSync(invalidUtf8).equals(invalidBytes), 'omega_edit must reject invalid UTF-8 without byte corruption');

  const bom = path.join(scratch, 'bom.txt');
  writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')]));
  chmodSync(bom, 0o750);
  const bomEdit = omegaEdit({ edits: [{ path: bom, oldString: 'hello', newString: 'world' }] });
  const bomBytes = readFileSync(bom);
  ok(!bomEdit.isError && bomBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'omega_edit must preserve UTF-8 BOM');
  ok((statSync(bom).mode & 0o777) === 0o750, 'omega_edit atomic replacement must preserve file mode');

  const crlf = path.join(scratch, 'crlf.txt');
  writeFileSync(crlf, 'a\r\nb\r\n');
  const crlfEdit = omegaEdit({ edits: [{ path: crlf, oldString: 'b', newString: 'b\nc' }] });
  ok(!crlfEdit.isError && readFileSync(crlf, 'utf8') === 'a\r\nb\r\nc\r\n', 'omega_edit must normalize replacement newlines to CRLF');

  const assertions = path.join(scratch, 'final-assertions.txt');
  writeFileSync(assertions, 'foo\n');
  const undoneAssertion = omegaEdit({ edits: [
    { path: assertions, oldString: 'foo', newString: 'bar', mustContain: ['bar'], mustMatch: ['^bar$'] },
    { path: assertions, oldString: 'bar', newString: 'baz' },
  ] });
  ok(undoneAssertion.isError && readFileSync(assertions, 'utf8') === 'foo\n', 'later chained edits must not invalidate earlier final assertions');
  const regexBan = omegaEdit({ edits: [{ path: assertions, oldString: 'foo', newString: 'secret=1', mustNotMatch: ['secret\\s*='] }] });
  ok(regexBan.isError && readFileSync(assertions, 'utf8') === 'foo\n', 'mustNotMatch must reject matching final text');
}

// ---- omega_edit: stale-file and caller hash protection ----
{
  const safe = path.join(scratch, 'stale-safe.txt');
  const stale = path.join(scratch, 'stale-target.txt');
  writeFileSync(safe, 'safe\n');
  writeFileSync(stale, 'original\n');
  const racingEdit = { path: stale, oldString: 'original', newString: 'planned' };
  Object.defineProperty(racingEdit, 'mustContain', {
    get() {
      writeFileSync(stale, 'external change\n');
      return ['planned'];
    },
  });
  const r = omegaEdit({ edits: [
    { path: safe, oldString: 'safe', newString: 'unsafe' },
    racingEdit,
  ] });
  ok(r.isError && r.text.includes('stale-file protection'), 'a file changed after planning must abort the batch: ' + r.text);
  ok(readFileSync(safe, 'utf8') === 'safe\n', 'stale rejection must leave every other file untouched');
  ok(readFileSync(stale, 'utf8') === 'external change\n', 'stale rejection must preserve the external writer content');

  const hash = createHash('sha256').update('safe\n').digest('hex');
  const hashOk = omegaEdit({ dryRun: true, edits: [
    { path: safe, oldString: 'safe', newString: 'SAFE', expectedSha256: hash },
  ] });
  ok(!hashOk.isError && readFileSync(safe, 'utf8') === 'safe\n', 'matching expectedSha256 dry run must verify without writing');
  const hashBad = omegaEdit({ edits: [
    { path: safe, oldString: 'safe', newString: 'SAFE', expectedSha256: '0'.repeat(64) },
  ] });
  ok(hashBad.isError && readFileSync(safe, 'utf8') === 'safe\n', 'mismatched expectedSha256 must reject without writing');

  const appeared = path.join(scratch, 'appeared-during-plan.txt');
  const createRace = { path: appeared, oldString: '', newString: 'ours\n' };
  Object.defineProperty(createRace, 'mustContain', {
    get() {
      writeFileSync(appeared, 'external\n');
      return ['ours'];
    },
  });
  const appearedResult = omegaEdit({ createIfMissing: true, edits: [createRace] });
  ok(appearedResult.isError && appearedResult.text.includes('appeared after planning'), 'a newly appeared file must abort createIfMissing');
  ok(readFileSync(appeared, 'utf8') === 'external\n', 'createIfMissing race must preserve the external file');

  const neverCreated = path.join(scratch, 'hash-new.txt');
  const newWithHash = omegaEdit({ createIfMissing: true, edits: [
    { path: neverCreated, oldString: '', newString: 'x', expectedSha256: hash },
  ] });
  ok(newWithHash.isError && !existsSync(neverCreated), 'expectedSha256 on a missing file must reject without creating it');
}

// ---- omega_edit: one failure voids the whole batch ----
{
  const a = path.join(scratch, 'two-phase-a.txt');
  const b = path.join(scratch, 'two-phase-b.txt');
  writeFileSync(a, 'keep\n');
  writeFileSync(b, 'keep\n');
  const r = omegaEdit({ edits: [
    { path: a, oldString: 'keep', newString: 'CHANGED' },
    { path: b, oldString: 'nope-not-present', newString: 'x' },
  ] });
  ok(r.isError, 'a missing oldString must fail the batch');
  ok(readFileSync(a, 'utf8') === 'keep\n', 'first edit must be rolled back, got ' + readFileSync(a, 'utf8'));
  ok(r.text.includes('[void]'), 'failure report must mark applied-looking lines as void');
  ok(/every \[void\] line below was NOT applied/.test(r.text), 'failure report must say the [ok] lines never landed');
}

// ---- omega_edit: createIfMissing ----
{
  const f = path.join(scratch, 'created', 'new.txt');
  const r = omegaEdit({ createIfMissing: true, edits: [{ path: f, oldString: '', newString: 'hello\n' }] });
  ok(!r.isError, 'createIfMissing must scaffold a file: ' + r.text);
  ok(existsSync(f) && readFileSync(f, 'utf8') === 'hello\n', 'scaffolded file must hold the new content');
  // A new file whose oldString is not empty is a mistake, not a partial match.
  const g = path.join(scratch, 'created', 'bad.txt');
  const r2 = omegaEdit({ createIfMissing: true, edits: [{ path: g, oldString: 'something', newString: 'x' }] });
  ok(r2.isError, 'createIfMissing must reject a non-empty oldString for a missing file');
  ok(!existsSync(g), 'a rejected create must not leave the file behind');
}

// ---- omega_undo: restores content AND deletes created files ----
{
  const f = path.join(scratch, 'undo-me.txt');
  writeFileSync(f, 'original\n');
  const r = omegaEdit({ edits: [{ path: f, oldString: 'original', newString: 'changed' }] });
  ok(!r.isError, 'edit before undo must succeed');
  const m = /undo point: (edit-[a-z0-9-]+)/.exec(r.text);
  ok(!!m, 'edit result must report an undo point id, got: ' + r.text);
  if (m) {
    ok(readFileSync(f, 'utf8') === 'changed\n', 'file must be changed before undo, got ' + readFileSync(f, 'utf8'));
    const u = omegaUndo({ batchId: m[1] });
    ok(!u.isError, 'undo must succeed: ' + u.text);
    ok(readFileSync(f, 'utf8') === 'original\n', 'undo must restore original content, got ' + readFileSync(f, 'utf8'));
    const again = omegaUndo({ batchId: m[1], dryRun: true });
    ok(!again.isError, 'undo dryRun must not error');
  }
  const created = path.join(scratch, 'undo-created.txt');
  const rc = omegaEdit({ createIfMissing: true, edits: [{ path: created, oldString: '', newString: 'temp\n' }] });
  const mc = /undo point: (edit-[a-z0-9-]+)/.exec(rc.text);
  ok(!!mc, 'create edit must also report an undo point');
  if (mc) {
    ok(existsSync(created), 'created file must exist before undo');
    omegaUndo({ batchId: mc[1] });
    ok(!existsSync(created), 'undo must DELETE a file that did not exist before, not blank it');
  }
}

// ---- omega_read: bounded context around pattern matches ----
{
  const f = path.join(scratch, 'read-context.js');
  writeFileSync(f, 'const before = 1;\nfunction target() {\n  return before;\n}\nconst after = 2;\n');
  const plain = omegaRead({ files: [{ path: f, pattern: 'function target' }] });
  ok(!plain.isError && plain.text.includes('2: function target() {'), 'omega_read plain pattern mode must retain numbered matches');
  ok(!plain.text.includes('1: const before'), 'omega_read must not add context unless requested');
  const contextual = omegaRead({ files: [{ path: f, pattern: 'function target', contextBefore: 1, contextAfter: 2 }] });
  ok(!contextual.isError && contextual.text.includes('1: const before = 1;'), 'omega_read contextBefore must include preceding code');
  ok(contextual.text.includes('4: }') && contextual.text.includes('context=-1/+2'), 'omega_read contextAfter and summary must be explicit');
  const merged = omegaRead({ files: [{ path: f, pattern: 'const|function', contextAfter: 1 }] });
  ok((merged.text.match(/2: function target/g) || []).length === 1, 'overlapping omega_read contexts must merge without duplicate lines');
  const outline = omegaRead({ files: [{ path: f, outline: true }] });
  ok(!outline.isError && outline.text.includes('2: function target'), 'omega_read outline must identify JavaScript declarations: ' + outline.text);
  ok(outline.text.includes('heuristic outline'), 'omega_read must label outlines as heuristic');
  const symbol = omegaRead({ files: [{ path: f, symbol: 'target' }] });
  ok(!symbol.isError && symbol.text.includes('function target'), 'omega_read symbol mode must filter exact declaration names');
  const conflicting = omegaRead({ files: [{ path: f, symbol: 'target', pattern: 'target' }] });
  ok(conflicting.isError && conflicting.text.includes('INVALID SPEC'), 'omega_read must reject ambiguous pattern plus symbol mode');
}

// ---- omega_grep: boundaries, context, and subprocess errors ----
{
  const wrong = await omegaGrep({ pattern: 'x', path: scratch });
  ok(wrong.isError, 'omega_grep must reject the `path` parameter instead of silently ignoring it');
  ok(wrong.text.includes('"path" -> use "dir"'), 'omega_grep must name the correct parameter: ' + wrong.text);
  const right = await omegaGrep({ pattern: 'TWO-CHAINED', dir: scratch });
  ok(!right.isError && right.text.includes('chain.txt'), 'omega_grep must still find matches with dir: ' + right.text);
  const source = path.join(scratch, 'grep-context.txt');
  writeFileSync(source, 'before\nneedle\nafter\n');
  const context = await omegaGrep({ pattern: 'needle', dir: scratch, include: 'grep-context.txt', contextBefore: 1, contextAfter: 1 });
  ok(!context.isError && context.text.includes('before') && context.text.includes('after'), 'omega_grep must return requested source context: ' + context.text);
  ok(context.text.includes('context -B1 -A1'), 'omega_grep summary must state requested context: ' + context.text);
  const exactLimit = await omegaGrep({ pattern: 'needle', dir: scratch, include: 'grep-context.txt', maxMatches: 1 });
  ok(!exactLimit.text.includes('(truncated'), 'omega_grep must not claim truncation when matches exactly equal maxMatches');
  const invalid = await omegaGrep({ pattern: '[', dir: scratch });
  ok(invalid.isError, 'omega_grep must report invalid regex subprocess failures as errors: ' + invalid.text);
  writeFileSync(path.join(scratch, 'literal.txt'), 'value[one]\nneedleish needle\n');
  const literalFound = await omegaGrep({ pattern: '[', dir: scratch, include: 'literal.txt', literal: true });
  ok(!literalFound.isError && literalFound.text.includes('value[one]'), 'omega_grep literal mode must accept regex metacharacters');
  const word = await omegaGrep({ pattern: 'needle', dir: scratch, include: 'literal.txt', literal: true, word: true });
  ok(!word.isError && word.text.includes('needleish needle'), 'omega_grep word mode must find a whole-word occurrence');
  const excludedFile = path.join(scratch, 'excluded.txt');
  writeFileSync(excludedFile, 'EXCLUDE_MARKER\n');
  const excluded = await omegaGrep({ pattern: 'EXCLUDE_MARKER', dir: scratch, exclude: ['excluded.txt'] });
  ok(!excluded.isError && excluded.text.includes('(no matches)'), 'omega_grep exclude globs must suppress matching files: ' + excluded.text);

  // ---- regression 2026-09-30: the fallback silently downgraded to BRE ----
  // The grep branch ran without -E, so `alpha|beta` was a literal pipe and the
  // call answered "(no matches)" for a file containing both words -- a wrong
  // answer with exit 1 and no error, which reads exactly like "not there".
  // Every other grep test above used a literal needle, so the suite stayed
  // green while the bug was live. These assertions pin the DIALECT, and they
  // must hold on the rg path and the grep path alike.
  const dialect = path.join(scratch, 'dialect.txt');
  writeFileSync(dialect, 'alpha\nbeta\ngamma\n');
  const alternation = await omegaGrep({ pattern: 'alpha|beta', dir: scratch, include: 'dialect.txt' });
  ok(!alternation.isError && alternation.text.includes('dialect.txt'),
    'omega_grep must treat | as alternation (ERE), not a literal pipe: ' + alternation.text);
  const group = await omegaGrep({ pattern: '(alpha|beta)$', dir: scratch, include: 'dialect.txt' });
  ok(!group.isError && group.text.includes('dialect.txt'),
    'omega_grep must support grouping parens: ' + group.text);
  const plus = await omegaGrep({ pattern: 'alph+', dir: scratch, include: 'dialect.txt' });
  ok(!plus.isError && plus.text.includes('dialect.txt'),
    'omega_grep must support + as a repetition operator: ' + plus.text);
  // The summary must always name the engine, so a reader can tell which
  // semantics produced the answer.
  ok(/via (rg|grep)/.test(alternation.text), 'omega_grep must name its engine in the summary: ' + alternation.text);

  // ---- engine parity: the two backends must answer IDENTICALLY ----
  // Oracle has no ripgrep, so every regex there runs on the grep fallback. If
  // the branches can disagree, a pattern that works on the Mac silently
  // returns nothing on Oracle -- the exact class of bug this section is about.
  // Pin both engines on the same inputs and compare the match sets.
  const parities = ['alpha|beta', '(alpha|beta)$', 'alph+', 'a.p', 'zzz|nomatch', '^gamma$'];
  for (const pat of parities) {
    const viaRg = await omegaGrep({ pattern: pat, dir: scratch, include: 'dialect.txt' }, { forceGrep: false });
    const viaGrep = await omegaGrep({ pattern: pat, dir: scratch, include: 'dialect.txt' }, { forceGrep: true });
    const normalize = (t) => t.split('\n').filter((l) => l.includes('dialect.txt:')).join('\n');
    ok(normalize(viaRg.text) === normalize(viaGrep.text),
      `omega_grep engines must agree on /${pat}/ (rg and grep -E):\n  rg:   ${normalize(viaRg.text) || '(none)'}\n  grep: ${normalize(viaGrep.text) || '(none)'}`);
    ok(viaGrep.text.includes('via grep'), 'forced fallback must report the grep engine: ' + viaGrep.text);
  }
}

// ---- db_query dryRun must NOT write (write-enabled build only) ----
// Regression: the first write-enabled build answered dryRun with "NOTHING
// WRITTEN" while actually calling run(), so the statement executed. The probe
// below is an UPDATE whose WHERE matches no row, so even a regressed build
// changes 0 rows -- the test proves dry-run behaviour without dirtying the
// asset store, and the row count is the assertion that it stayed put.
// Oracle runs the read-only build, where these writes are refused outright; it
// asserts the fence instead.
const dbDefForTests = EXTRA_TOOLS.find((t) => t.name === 'db_query');
const dbWriteEnabled = !!(dbDefForTests && dbDefForTests.inputSchema.properties.dryRun);
if (dbWriteEnabled) {
  const countRows = async () => {
    const r = await dbQuery({ sql: 'SELECT count(*) FROM memory;' });
    return (r.text || '').trim();
  };
  const before = await countRows();
  const dry = await dbQuery({
    sql: "UPDATE memory SET content = 'DRYRUN_PROBE' WHERE key = '__omega_no_such_key__';",
    dryRun: true,
  });
  ok(!dry.isError, 'db_query dryRun on a valid write must not error: ' + dry.text.slice(0, 200));
  ok(/NOTHING WRITTEN/i.test(dry.text), 'db_query dryRun must label itself NOTHING WRITTEN');
  ok(!/WRITE ok=/.test(dry.text), 'db_query dryRun must NOT report a write receipt');
  const after = await countRows();
  ok(before === after, `db_query dryRun must not change row count (${before} -> ${after})`);

  // The fence itself: a non-whitelisted table is refused with no snapshot taken.
  const denied = await dbQuery({ sql: 'INSERT INTO sqlite_master_does_not_exist (a) VALUES (1);' });
  ok(denied.isError, 'db_query must refuse a table outside the whitelist');
  ok(!/WRITE ok=/.test(denied.text), 'a refused write must not produce a write receipt');
  // DDL stays refused unconditionally, snapshot or not.
  const ddl = await dbQuery({ sql: 'DROP TABLE memory;' });
  ok(ddl.isError, 'db_query must refuse DROP even with a snapshot path available');
  ok(/never allowed/i.test(ddl.text), 'the DDL refusal must say it is unconditional');
} else {
  // Read-only build (Oracle): every write class is refused by the same fence,
  // and no write receipt may ever appear.
  for (const [label, sql] of [
    ['INSERT', "INSERT INTO memory (slot, key, content) VALUES ('x','y','z');"],
    ['UPDATE', "UPDATE memory SET content = 'probe';"],
    ['DELETE', 'DELETE FROM memory;'],
    ['DROP', 'DROP TABLE memory;'],
    ['PRAGMA assignment', 'PRAGMA journal_mode = WAL;'],
    ['VACUUM', 'VACUUM;'],
  ]) {
    const r = await dbQuery({ sql });
    ok(r.isError, `read-only db_query must refuse ${label}`);
    ok(!/WRITE ok=/.test(r.text), `read-only db_query must not emit a write receipt for ${label}`);
  }
  const read = await dbQuery({ sql: 'SELECT count(*) FROM memory;' });
  ok(!read.isError, 'read-only db_query must still allow SELECT');
}

// ---- tool registry sanity ----
// The two hosts DIVERGE on db_query by design: Mac runs the write-enabled build
// (DML + whitelist + auto .backup), Oracle keeps the original read-only build
// because its db_query is maintained separately there. The suite detects which
// build it is running against and asserts the right contract for each, so one
// file can guard both hosts instead of forking.
{
  const names = EXTRA_TOOLS.map((t) => t.name);
  for (const n of ['omega_undo', 'db_query', 'omega_edit', 'omega_batch_status', 'omega_batch_cancel', 'omega_grep']) {
    ok(names.includes(n), `EXTRA_TOOLS must advertise ${n}`);
  }
  const dbDef = EXTRA_TOOLS.find((t) => t.name === 'db_query');
  const writeEnabled = !!(dbDef && dbDef.inputSchema.properties.dryRun);
  if (writeEnabled) {
    ok(/refused/i.test(dbDef.description) && /backup/i.test(dbDef.description),
      'write-enabled db_query must state the fence and the snapshot');
    ok(/snapshot|backup/i.test(dbDef.description), 'write-enabled db_query must document the snapshot');
  } else {
    ok(/Writes are refused\./.test(dbDef.description),
      'read-only db_query must still say writes are refused');
    ok(!dbDef.inputSchema.properties.dryRun, 'read-only db_query must not advertise dryRun');
  }
  for (const t of EXTRA_TOOLS) {
    if (t.name === 'omega_undo') ok(t.inputSchema.required.includes('batchId'), 'omega_undo must require batchId');
    if (t.name === 'omega_edit') {
      ok(t.inputSchema.properties.createIfMissing, 'omega_edit must expose createIfMissing');
      ok(t.inputSchema.properties.edits.items.properties.expectedSha256, 'omega_edit must expose expectedSha256');
      ok(t.inputSchema.properties.edits.items.properties.mustMatch, 'omega_edit must expose mustMatch');
    }
    if (t.name === 'vfs_local_write') ok(t.inputSchema.properties.requireMissing, 'vfs_local_write must expose requireMissing');
    if (t.name === 'omega_batch_status') ok(t.inputSchema.properties.waitMs, 'omega_batch_status must expose waitMs');
    if (t.name === 'omega_batch_status') ok(t.inputSchema.properties.format, 'omega_batch_status must expose format');
    if (t.name === 'omega_batch_cancel') ok(t.inputSchema.required.includes('id'), 'omega_batch_cancel must require id');
    if (t.name === 'omega_read') {
      ok(t.inputSchema.properties.files.items.properties.contextBefore, 'omega_read must expose contextBefore');
      ok(t.inputSchema.properties.files.items.properties.outline, 'omega_read must expose outline');
    }
    if (t.name === 'omega_grep') {
      ok(t.inputSchema.properties.contextAfter, 'omega_grep must expose contextAfter');
      ok(t.inputSchema.properties.literal && t.inputSchema.properties.exclude, 'omega_grep must expose literal and exclude');
    }
    ok(typeof t.description === 'string' && t.description.length > 0, `${t.name} must carry a non-empty description`);
  }
  console.log(`  (db_query build on this host: ${writeEnabled ? 'write-enabled' : 'read-only'})`);
}

// ---- guard still refuses after the false-positive fix ----
ok(!inspectCommand('echo x > /etc/x').ok, 'guard must still refuse an absolute redirect');
ok(inspectCommand('node -e "x => x"').ok, 'guard must allow an arrow function');
ok(inspectCommand('echo x > /tmp/f').ok, 'guard must allow /tmp');

// ---- the tool PATH self-heal, exercised under the PATH that actually broke it ----
// GenCode's server env is bundled-resources/bin + system dirs, with no Homebrew
// prefix, so every `rg` probe failed. Assert the invariant directly rather than
// trusting the ambient shell: importing the module under a stripped PATH must
// still leave the tool dirs reachable. This runs in a child because the parent
// already fixed its own PATH at import time.
{
  const probe = `
    const { toolPathExtras } = await import(${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools-ext.mjs'))});
    const sep = ':';
    const cur = (process.env.PATH || '').split(sep);
    const missing = toolPathExtras().filter((d) => !cur.includes(d));
    console.log(missing.length === 0 ? 'PATH-HEALED' : 'PATH-MISSING:' + missing.join(','));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/Users/yay/Library/Application Support/ai.mainfunc.genspark.terminal/bundled-resources/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok(out.includes('PATH-HEALED'),
    'importing tools-ext under a minimal PATH must still expose the tool dirs (rg/sqlite3 probes): ' + out.trim());
}

rmSync(scratch, { recursive: true, force: true });

console.log(`tools-ext: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}
