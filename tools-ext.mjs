// Extra tools for the omega MCP bridge: vfs_local_write, db_query, and an async
// omega_batch runner. Kept in a separate module so server.mjs stays readable;
// imported dynamically so a failure here cannot stop run_process.

import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, copyFileSync, rmSync, renameSync, chmodSync, linkSync, readdirSync } from 'node:fs';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { guardSteps, inspectCommand } from './batch-guard.mjs';

// ---------- tool PATH (self-healing, runs before anything probes a binary) ----------
// GenCode launches this server with a minimal PATH (bundled-resources/bin, the
// system dirs) that has no Homebrew prefix, so `rg` — installed at
// /opt/homebrew/bin/rg — probed as absent and omega_grep silently fell back to
// grep. Fallback then broke regex semantics too (BRE has no `|`), so
// `omega_grep pattern:"a|b"` returned "(no matches)" on a file that contains
// both, with exit 1 and no error. Found 2026-09-30 by probing the live server.
// Fixing it here, at module load, so EVERY binary probe in this file (rg,
// sqlite3, python3) sees the same PATH the batch shells already got.
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const pathSep = process.platform === 'win32' ? ';' : ':';
{
  const cur = (process.env.PATH || '').split(pathSep).filter(Boolean);
  const extra = TOOL_DIRS.filter((d) => !cur.includes(d));
  if (extra.length) process.env.PATH = [...extra, ...cur].join(pathSep);
}
// A caller-supplied PATH still wins: withToolPath() in server.mjs prepends the
// same dirs to the child env, and explicit `environment.PATH` overrides this.
export function toolPathExtras() { return TOOL_DIRS; }

const DB = process.env.OMEGA_DB
  || path.join(homedir(), 'workspace/genspark-agent/server-v2/data/agent.db');
const DBFILE_DIR = path.dirname(path.dirname(DB));
// Snapshots taken before a write-enabled db_query touches the asset store.
const DB_BACKUP_DIR = process.env.OMEGA_DB_BACKUP_DIR
  || path.join(homedir(), 'workspace/genspark-agent/server-v2/db-backups');
// Write mode is a host decision, not a fork: OMEGA_DB_WRITES=1 enables the
// fenced write path (DML on whitelisted tables, snapshotted). Unset/0 keeps
// the historical read-only refusal. One codebase, both hosts.
const DB_WRITES = process.env.OMEGA_DB_WRITES === '1';

// ---------- write snapshots (pre-write backup + rollback) ----------
// File-level undo net for omega_edit. db_query writes (when enabled) take
// their own .backup snapshot in dbQuery below; this section never touches SQL.
const SNAP_DIR = process.env.OMEGA_SNAP_DIR || '/tmp/omega-snaps';
const snapStats = new Map(); // batchId -> [{ path, snap, existed }]

function snapshotFile(abs, batchId) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const sha = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
  const snap = path.join(SNAP_DIR, `${sha}.snap`);
  if (!existsSync(snap)) copyFileSync(abs, snap);
  const list = snapStats.get(batchId) || [];
  list.push({ path: abs, snap, existed: true });
  snapStats.set(batchId, list);
  return snap;
}

function snapshotMissing(abs, batchId) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const sha = createHash('sha256').update(abs).digest('hex').slice(0, 16);
  const snap = path.join(SNAP_DIR, `absent-${sha}.snap`);
  if (!existsSync(snap)) writeFileSync(snap, '');
  const list = snapStats.get(batchId) || [];
  list.push({ path: abs, snap, existed: false });
  snapStats.set(batchId, list);
}

// Restoring a file that never existed means deleting what we created, not
// writing an empty file over it -- otherwise "undo" leaves litter behind.
function describe(entry) {
  return entry.existed ? `restored ${entry.path}` : `removed ${entry.path} (did not exist before)`;
}

function restoreOne(entry) {
  if (entry.existed) {
    mkdirSync(path.dirname(entry.path), { recursive: true });
    copyFileSync(entry.snap, entry.path);
    return `restored ${entry.path}`;
  }
  rmSync(entry.path, { force: true });
  return `removed ${entry.path} (did not exist before)`;
}

function persistSnapManifest(batchId, list) {
  mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(path.join(SNAP_DIR, `${batchId}.json`), JSON.stringify(list, null, 1));
}

export function omegaUndo(args) {
  const batchId = args.batchId;
  if (!batchId) return { isError: true, text: 'batchId is required' };
  let list = snapStats.get(batchId);
  const f = path.join(SNAP_DIR, `${batchId}.json`);
  if (!list && existsSync(f)) list = JSON.parse(readFileSync(f, 'utf8'));
  if (!list || !list.length) return { isError: true, text: `no snapshot for batch: ${batchId}` };
  const dry = args.dryRun === true;
  if (args.paths) {
    const want = new Set((Array.isArray(args.paths) ? args.paths : [args.paths]).map((p) => path.resolve(p)));
    list = list.filter((e) => want.has(e.path));
    if (!list.length) return { isError: true, text: 'no snapshot entries match the given paths' };
  }
  const lines = list.map((e) => {
    if (dry) return `[dry] ${describe(e)}`;
    return restoreOne(e);
  });
  return {
    isError: false,
    text: `undo ${batchId}: ${list.length} file(s) ${dry ? 'WOULD BE RESTORED (DRY-RUN)' : 'restored'}\n${lines.join('\n')}`,
  };
}

// ---------- vfs_local_write ----------
// Exists so content with quotes, $, newlines or CJK never has to survive a shell
// quoting layer: write the file, then run it.
export function vfsLocalWrite(args) {
  if (!args.path) return { isError: true, text: 'path is required' };
  const sources = ['content', 'content_b64', 'content_file'].filter((key) => args[key] !== undefined);
  if (sources.length !== 1) {
    return { isError: true, text: `exactly one of content / content_b64 / content_file is required (received ${sources.length})` };
  }
  const abs = path.resolve(args.path);
  let body;
  try {
    if (sources[0] === 'content_b64') {
      const encoded = String(args.content_b64).replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return { isError: true, text: 'content_b64 is not valid canonical base64' };
      }
      body = Buffer.from(encoded, 'base64');
    } else if (sources[0] === 'content_file') {
      body = readFileSync(path.resolve(args.content_file));
    } else {
      body = Buffer.from(String(args.content), 'utf8');
    }
  } catch (err) {
    return { isError: true, text: `content read failed: ${err.message}` };
  }

  const existed = existsSync(abs);
  if (args.requireMissing && existed) {
    return { isError: true, text: `refused: target already exists: ${abs}` };
  }
  let initial = null;
  if (existed) {
    try {
      const st = statSync(abs);
      if (!st.isFile()) return { isError: true, text: `target is not a file: ${abs}` };
      initial = {
        hash: createHash('sha256').update(readFileSync(abs)).digest('hex'),
        dev: st.dev,
        ino: st.ino,
        mode: st.mode & 0o777,
      };
    } catch (err) {
      return { isError: true, text: `target inspection failed: ${err.message}` };
    }
  }
  if (args.expectedSha256 !== undefined) {
    const expected = String(args.expectedSha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) return { isError: true, text: 'expectedSha256 must be a 64-character hexadecimal digest' };
    if (!initial || initial.hash !== expected) {
      return { isError: true, text: `expectedSha256 mismatch: expected ${expected}, found ${initial ? initial.hash : '(missing file)'}` };
    }
  }

  mkdirSync(path.dirname(abs), { recursive: true });
  if (args.append) {
    // Retain append(2) semantics rather than pretending a read-concatenate-rename
    // cycle is safe in the presence of other appenders.
    try {
      writeFileSync(abs, body, { flag: args.requireMissing ? 'ax' : 'a' });
      return { isError: false, text: `appended: ${abs} (${body.length} bytes)` };
    } catch (err) {
      return { isError: true, text: `append failed: ${err.message}` };
    }
  }

  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.omega-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, body, initial ? { mode: initial.mode } : undefined);
    if (initial) chmodSync(temp, initial.mode);
    if (args.requireMissing && existsSync(abs)) throw new Error('target appeared while content was staged');
    if (initial && args.expectedSha256 !== undefined) {
      const st = statSync(abs);
      const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (st.dev !== initial.dev || st.ino !== initial.ino || hash !== initial.hash) {
        throw new Error('target changed while content was staged');
      }
    }
    if (args.requireMissing) {
      // link(2) fails atomically with EEXIST, unlike rename which replaces.
      linkSync(temp, abs);
      rmSync(temp, { force: true });
    } else {
      renameSync(temp, abs);
    }
    const writtenHash = createHash('sha256').update(body).digest('hex');
    return { isError: false, text: `written atomically: ${abs} (${body.length} bytes, sha256 ${writtenHash})` };
  } catch (err) {
    try { rmSync(temp, { force: true }); } catch {}
    return { isError: true, text: `write failed, target not replaced: ${err.message}` };
  }
}

// ---------- db_query (reads free, writes fenced when OMEGA_DB_WRITES=1) ----------
// This database is the 2026-09-27 recovered asset store, so writes are allowed
// but fenced: DML only, on named tables, and every write is preceded by a real
// .backup snapshot and followed by integrity_check + a row-count delta report.
// drop/alter/truncate/attach/vacuum stay refused unconditionally -- no snapshot
// makes "delete the table" a reasonable thing to let a model do unattended.
const WRITE_RE = /^\s*(insert|update|delete|drop|alter|create|replace|truncate|vacuum|attach|detach|pragma\s+\w+\s*=)/i;
const DML_RE = /^\s*(insert|update|replace)\b/i;
const DELETE_RE = /^\s*delete\b/i;
const FORBIDDEN_WRITE_RE = /\b(drop|alter|truncate|attach|detach|vacuum|reindex|pragma\s+\w+\s*=)\b/i;
const DB_WRITABLE_TABLES = new Set([
  'memory', 'local_store', 'playbook', 'scripts', 'skills', 'lessons',
  'articles', 'commands', 'logs',
]);

function tablesInSql(sql) {
  const out = new Set();
  const re = /\b(?:into|update|from|join)\s+["'`\[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) out.add(m[1]);
  return out;
}

function spawnSyncLite(bin, argv) {
  const r = spawnSync(bin, argv, { encoding: 'utf8' });
  if (r.error) return { ok: false, error: r.error.message };
  return { ok: r.status === 0, error: (r.stderr || '').trim() || null, out: r.stdout || '' };
}

// Every fenced write copies the WHOLE database (69 MB here), so an unbounded
// snapshot dir filled 139 MB from two writes on 2026-09-30. Retention is part
// of the fence, not an afterthought: keep the newest N (default 10, ~700 MB
// worst case) and prune older ones after a successful snapshot. Never prune the
// snapshot just taken -- the rollback path in the receipt must stay valid for
// the whole turn. OMEGA_DB_BACKUP_KEEP=0 disables retention entirely.
const DB_BACKUP_KEEP = Number.isFinite(Number(process.env.OMEGA_DB_BACKUP_KEEP))
  ? Number(process.env.OMEGA_DB_BACKUP_KEEP) : 10;

function pruneDbBackups() {
  if (DB_BACKUP_KEEP <= 0) return { pruned: 0 };
  let files;
  try {
    files = readdirSync(DB_BACKUP_DIR)
      .filter((f) => /^agent-.*\.db(-wal|-shm)?$/.test(f))
      .sort(); // ISO-8601 stamps sort lexicographically = oldest first
  } catch { return { pruned: 0 }; }
  // Count whole snapshots, not files: a -wal/-shm sidecar is part of its
  // snapshot, and the source db is in WAL mode so every snapshot can leave a
  // pair behind. Counting files separately would let a pruned snapshot's
  // sidecars (163 KB of -shm observed) sit in the dir forever.
  const stems = new Set(files.map((f) => f.replace(/-(wal|shm)$/, '')));
  const ordered = [...stems].sort();
  const excess = ordered.length - DB_BACKUP_KEEP;
  if (excess <= 0) return { pruned: 0 };
  const doomed = new Set(ordered.slice(0, excess));
  let pruned = 0;
  for (const f of files) {
    if (!doomed.has(f.replace(/-(wal|shm)$/, ''))) continue;
    try { rmSync(path.join(DB_BACKUP_DIR, f)); pruned++; } catch { /* best effort */ }
  }
  return { pruned, kept: DB_BACKUP_KEEP };
}

function dbBackup(tag) {
  mkdirSync(DB_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const dest = path.join(DB_BACKUP_DIR, `agent-${stamp}-${tag}.db`);
  const r = spawnSyncLite('sqlite3', [DB, `.backup ${dest}`]);
  if (!r.ok) return { ok: false, dest, error: r.error };
  // Collapse the snapshot out of WAL mode. The source db is WAL, so .backup
  // leaves a -wal beside the snapshot; the receipt tells the caller to roll back
  // with a plain `cp snapshot.db live.db`, and a cp that ignores a non-empty -wal
  // silently restores a stale database. One self-contained file makes that
  // command true. This is the whole reason .backup is used over cp.
  spawnSyncLite('sqlite3', [dest, 'PRAGMA journal_mode=DELETE;']);
  for (const sidecar of [`${dest}-wal`, `${dest}-shm`]) {
    try { rmSync(sidecar, { force: true }); } catch { /* best effort */ }
  }
  return { ok: true, dest, ...pruneDbBackups() };
}

// dbfile.cjs is a node script, but the .backup CLI is the only snapshot that is
// safe on a WAL database (cp of a live db captures a torn state). Fall back to
// python3's sqlite3 when the sqlite3 CLI is missing, and say so in the receipt.
function integrityCheck() {
  const r = spawnSyncLite('sqlite3', [DB, 'PRAGMA integrity_check;']);
  if (r.ok) return { ok: true, verdict: (r.out || '').trim() };
  const py = spawnSyncLite('python3', ['-c',
    'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(c.execute("PRAGMA integrity_check").fetchone()[0])', DB]);
  if (py.ok) return { ok: true, verdict: (py.out || '').trim(), via: 'python3' };
  return { ok: false, verdict: `unknown (${r.error || py.error})` };
}

function rowCounts(tables) {
  const out = [];
  for (const t of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
    const r = spawnSyncLite('sqlite3', [DB, `SELECT count(*) FROM "${t}";`]);
    out.push([t, r.ok ? (r.out || '').trim() : '?']);
  }
  return out;
}

export function dbQuery(args) {
  let sql = args.sql;
  if (args.sql_b64) sql = Buffer.from(args.sql_b64, 'base64').toString('utf8');
  if (!sql) return Promise.resolve({ isError: true, text: 'sql or sql_b64 is required' });
  // Read-only on purpose unless the host opts into writes: the model drives
  // these calls unattended, and this database is the recovered asset store.
  // Writes go through a human-run path (dbfile.cjs) on read-only hosts.
  if (!DB_WRITES && WRITE_RE.test(sql)) {
    return Promise.resolve({
      isError: true,
      text: 'refused: this bridge is read-only (SELECT/PRAGMA/EXPLAIN/WITH only). '
        + 'Run writes yourself via dbfile.cjs.',
    });
  }
  const isWrite = WRITE_RE.test(sql);
  if (DB_WRITES && isWrite && FORBIDDEN_WRITE_RE.test(sql)) {
    return Promise.resolve({
      isError: true,
      text: 'refused: DDL/PRAGMA-assignment (drop/alter/truncate/attach/detach/vacuum/reindex) '
        + 'is never allowed through this bridge, snapshot or not. Use dbfile.cjs yourself.',
    });
  }
  const isDelete = isWrite && DELETE_RE.test(sql);
  if (DB_WRITES && isWrite && !(DML_RE.test(sql) || isDelete)) {
    return Promise.resolve({ isError: true, text: 'refused: only INSERT/UPDATE/REPLACE/DELETE are allowed here' });
  }
  const touched = isWrite ? [...tablesInSql(sql)] : [];
  if (DB_WRITES && isWrite) {
    const unknown = touched.filter((t) => !DB_WRITABLE_TABLES.has(t));
    if (unknown.length) {
      return Promise.resolve({
        isError: true,
        text: `refused: table(s) not writable through this bridge: ${unknown.join(', ')}. `
          + `Writable: ${[...DB_WRITABLE_TABLES].join(', ')}`,
      });
    }
  }
  const dry = DB_WRITES && args.dryRun === true;

  // process.execPath, not bare 'node': the child must run on the same runtime as
  // this server. A bare 'node' resolves via ambient PATH, and a PATH that puts
  // an older node first (Oracle SSH ships node v20, which lacks node:sqlite)
  // breaks every dbfile.cjs call while the server itself runs fine -- found
  // 2026-09-28 when the Oracle suite failed its SELECT probe for exactly this.
  const runText = (text) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['dbfile.cjs', 'query', text], { cwd: DBFILE_DIR, env: process.env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 60000);
    child.on('close', (code) => {
      clearTimeout(t);
      const text2 = (out || err || '(no output)').slice(0, 60000);
      resolve({ isError: code !== 0, text: code === 0 ? text2 : `exit=${code}\n${text2}` });
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ isError: true, text: e.message }); });
  });
  const run = () => runText(sql);

  if (!isWrite) return run();

  const before = rowCounts(touched);
  if (dry) {
    // Must NOT execute the statement. EXPLAIN compiles and plans it without
    // applying any change, so the caller still learns whether the fence and the
    // SQL are valid -- an earlier build called run() here and reported
    // "NOTHING WRITTEN" over a write it had just performed.
    return runText(`EXPLAIN ${sql}`).then((r) => ({
      isError: r.isError,
      text: `db_query DRY-RUN (NOTHING WRITTEN): ${touched.join(', ') || '(no table matched)'}\n`
        + `plan ok=${!r.isError}\n\n${r.text}`,
    }));
  }
  const bak = dbBackup('prewrite');
  if (!bak.ok) {
    return Promise.resolve({
      isError: true,
      text: `refused: could not snapshot the database before writing (.backup failed: ${bak.error}). `
        + 'Refusing to write without a rollback point.',
    });
  }
  return run().then((r) => {
    const after = rowCounts(touched);
    const delta = before.map(([t, b], i) => `${t}: ${b} -> ${after[i] ? after[i][1] : '?'}`).join('\n');
    const ic = integrityCheck();
    return {
      isError: r.isError,
      text: `db_query WRITE ok=${!r.isError} tables=[${touched.join(', ')}]\n`
        + `snapshot: ${bak.dest}\nrowcount: ${delta || '(n/a)'}\n`
        + `integrity: ${ic.verdict}${ic.via ? ` (via ${ic.via})` : ''}\n`
        // Not a bare `cp`: the live db is in WAL mode, so copying a file over it
        // leaves the old -wal/-shm beside the new file and SQLite replays stale
        // pages on next open -- a rollback that appears to work and does not.
        // The sidecars must go, and the restored copy must be checkpointed.
        + `rollback: rm -f ${DB}-wal ${DB}-shm && cp ${JSON.stringify(bak.dest)} ${DB} `
        + `&& sqlite3 ${DB} "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;"`
        + (bak.pruned ? `\nretention: pruned ${bak.pruned} old file(s), keeping ${bak.kept}` : '')
        + `\n\n${r.text}`,
    };
  });
}

// ---------- omega_batch (async) ----------
// MCP tools/call is request/response, but a batch can run for minutes, so the
// call returns a job id immediately and progress is polled separately.
const jobs = new Map();
const JOB_DIR = process.env.OMEGA_JOB_DIR || '/tmp/omega-jobs';

export function omegaBatch(args, runProcess) {
  // Enforced, not merely requested: MCP calls are permission-checked under their
  // own action name (permission=omega_omega_batch in the log), so a shell:deny or
  // edit:deny on the caller does not reach a batch step. Refuse content writes here.
  const objection = guardSteps(args && args.steps);
  if (objection) return { isError: true, text: objection };

  const steps = args.steps;
  if (!Array.isArray(steps) || !steps.length) {
    return Promise.resolve({ isError: true, text: 'steps must be a non-empty array' });
  }
  const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const job = {
    id, total: steps.length, done: 0, started: new Date().toISOString(),
    state: 'running', results: [], stopOnError: args.stopOnError !== false,
    cancelRequested: false,
  };
  jobs.set(id, job);
  mkdirSync(JOB_DIR, { recursive: true });

  (async () => {
    for (let i = 0; i < steps.length; i++) {
      if (job.cancelRequested) {
        job.state = 'cancelled';
        job.results.push({
          i: i + 1, label: '(cancelled)', ok: false, status: 'skipped',
          failureType: 'cancelled', note: 'cancel requested before this step', text: '', durationMs: 0,
        });
        break;
      }
      const step = steps[i];
      const label = step.label || step.command_line?.slice(0, 60) || `step${i + 1}`;
      const stepStarted = Date.now();
      try {
        const r = await runProcess({
          command_line: step.command_line,
          timeout: step.timeout,
          cwd: step.cwd,
          stdin: step.stdin,
        });
        let ok = !r.isError;
        let note = '';
        let failureType = ok ? null : 'process';
        // Semantic acceptance: a zero exit code does not mean the task succeeded.
        if (ok && step.expect) {
          const e = step.expect;
          const has = (s) => r.text.includes(s);
          const list = (v) => (Array.isArray(v) ? v : [v]);
          if (e.contains && !list(e.contains).every(has)) {
            ok = false; failureType = 'expectation'; note = `expect.contains failed: ${list(e.contains).filter((s) => !has(s)).join(', ')}`;
          }
          if (ok && e.notContains && list(e.notContains).some(has)) {
            ok = false; failureType = 'expectation'; note = `expect.notContains hit: ${list(e.notContains).filter(has).join(', ')}`;
          }
          if (ok && e.regex) {
            try {
              if (!new RegExp(e.regex, 'm').test(r.text)) {
                ok = false; failureType = 'expectation'; note = `expect.regex failed: ${e.regex}`;
              }
            } catch (err) {
              ok = false; failureType = 'configuration'; note = `expect.regex invalid: ${err.message}`;
            }
          }
        }
        job.results.push({
          i: i + 1,
          label,
          ok,
          status: ok ? 'passed' : 'failed',
          failureType,
          note,
          text: r.text.slice(0, 4000),
          durationMs: Date.now() - stepStarted,
          exitCode: r.exitCode ?? r.code ?? null,
          signal: r.signal ?? null,
          timedOut: r.timedOut === true,
        });
        job.done = i + 1;
        if (!ok && job.stopOnError) {
          job.state = 'failed';
          if (i + 1 < steps.length) {
            job.results.push({
              i: i + 2, label: '(halted)', ok: false, status: 'skipped',
              failureType: 'halted', note: 'stopOnError', text: '', durationMs: 0,
            });
          }
          break;
        }
      } catch (e) {
        job.results.push({
          i: i + 1, label, ok: false, status: 'failed', failureType: 'internal',
          note: String(e.message), text: '', durationMs: Date.now() - stepStarted,
        });
        job.done = i + 1;
        if (job.stopOnError) { job.state = 'failed'; break; }
      }
    }
    if (job.state === 'running') {
      job.state = job.results.every((r) => r.ok) ? 'success' : 'partial';
    }
    job.finished = new Date().toISOString();
    try {
      writeFileSync(path.join(JOB_DIR, `${id}.json`), JSON.stringify(job, null, 1));
    } catch { /* best effort */ }
  })();

  return Promise.resolve({
    isError: false,
    text: `batch started: ${id} (${steps.length} steps)\n`
      + `Poll with omega_batch_status {"id":"${id}"}.`,
  });
}

export function omegaBatchStatus(args) {
  const id = args.id;
  // waitMs blocks so a caller can get the verdict in ONE call instead of
  // submit-then-poll. Capped below the host's MCP timeout on purpose: a host
  // that cuts the call at 60s would lose the reply entirely.
  const waitMs = Math.min(50000, Math.max(0, Number(args.waitMs) || 0));
  const render = (job) => {
    if (!job) return null;
    if (args.format === 'json') {
      return {
        isError: job.state === 'failed' || job.state === 'partial',
        text: JSON.stringify(job, null, 2),
      };
    }
    const lines = [`batch ${job.id}: ${job.state} ${job.done}/${job.total}`];
    for (const r of job.results) {
      lines.push(`  [${r.ok ? 'ok' : 'FAIL'}] ${r.i}. ${r.label}${r.failureType ? ` (${r.failureType})` : ''}${r.note ? ` -- ${r.note}` : ''}`);
      if (!r.ok && r.text) lines.push(`      ${r.text.split('\n').slice(0, 6).join('\n      ').slice(0, 700)}`);
    }
    if (args.verbose) {
      for (const r of job.results) {
        lines.push(`--- step ${r.i} ${r.label} ---`, r.text.slice(0, 3000));
      }
    }
    return { isError: job.state === 'failed' || job.state === 'partial', text: lines.join('\n') };
  };
  if (waitMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const job = jobs.get(id) || (existsSync(path.join(JOB_DIR, `${id}.json`))
          ? JSON.parse(readFileSync(path.join(JOB_DIR, `${id}.json`), 'utf8')) : null);
        const done = job && job.state !== 'running';
        if (done || Date.now() - started >= waitMs) {
          const r = render(job);
          resolve(r || { isError: true, text: `no such batch: ${id}` });
          return;
        }
        setTimeout(tick, 300);
      };
      tick();
    });
  }
  let job = jobs.get(id);
  if (!job) {
    const f = path.join(JOB_DIR, `${id}.json`);
    if (existsSync(f)) job = JSON.parse(readFileSync(f, 'utf8'));
  }
  if (!job) return { isError: true, text: `no such batch: ${id}` };
  return render(job);
}

export function omegaBatchCancel(args) {
  const id = args.id;
  if (!id) return { isError: true, text: 'id is required' };
  const job = jobs.get(id);
  if (!job) {
    const f = path.join(JOB_DIR, `${id}.json`);
    if (existsSync(f)) {
      const saved = JSON.parse(readFileSync(f, 'utf8'));
      return { isError: true, text: `batch ${id} is already ${saved.state}; only a running in-memory job can be cancelled` };
    }
    return { isError: true, text: `no such batch: ${id}` };
  }
  if (job.state !== 'running') return { isError: true, text: `batch ${id} is already ${job.state}` };
  job.cancelRequested = true;
  job.cancelRequestedAt = new Date().toISOString();
  try {
    mkdirSync(JOB_DIR, { recursive: true });
    writeFileSync(path.join(JOB_DIR, `${id}.json`), JSON.stringify(job, null, 1));
  } catch { /* best effort */ }
  return {
    isError: false,
    text: `cancellation requested for ${id}; the active step is not killed, and no later step will start`,
  };
}

// ---------- omega_read (many files, one call) ----------
// Builtin Read does one file per call, so a 9-file recon costs 9 round trips.
// This packs N files -- each optionally sliced by line range and/or filtered by
// a regex -- into a single capped response. Pure fs, no shell quoting involved.
const READ_DEFAULT_LINES = 120;
const READ_MAX_LINES = 500;
const READ_DEFAULT_MATCHES = 30;
const READ_TOTAL_CAP = 20000;

function boundedInt(value, fallback, min, max) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, n));
}

// A dependency-free declaration outline, deliberately narrower than an AST.
// It reports only high-confidence, single-line declarations and labels the
// result heuristic so callers do not mistake it for semantic language data.
function sourceOutline(file, lines, max, symbol) {
  const ext = path.extname(file).toLowerCase();
  const common = [
    ['class', /^\s*(?:(?:export|public|private|protected|abstract|sealed|final|static)\s+)*(?:class|record)\s+([A-Za-z_$][\w$]*)/],
    ['interface', /^\s*(?:(?:export|public|private|protected)\s+)*interface\s+([A-Za-z_$][\w$]*)/],
    ['enum', /^\s*(?:(?:export|public|private|protected)\s+)*enum\s+([A-Za-z_$][\w$]*)/],
  ];
  let patterns = common;
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
    patterns = [
      ['function', /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/],
      ['type', /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/],
      ['namespace', /^\s*(?:export\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/],
      ['function', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/],
      ...common,
    ];
  } else if (ext === '.py') {
    patterns = [
      ['function', /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
      ['class', /^\s*class\s+([A-Za-z_]\w*)/],
    ];
  } else if (ext === '.go') {
    patterns = [
      ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
      ['type', /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
    ];
  } else if (ext === '.rs') {
    patterns = [
      ['function', /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/],
      ['struct', /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/],
      ['enum', /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/],
      ['trait', /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/],
    ];
  } else if (ext === '.rb') {
    patterns = [
      ['function', /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/],
      ['class', /^\s*class\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/],
      ['module', /^\s*module\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/],
    ];
  } else if (ext === '.php') {
    patterns = [
      ['function', /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/],
      ['trait', /^\s*(?:final\s+|abstract\s+)?trait\s+([A-Za-z_]\w*)/],
      ...common,
    ];
  }
  const found = [];
  for (let i = 0; i < lines.length && found.length < max; i++) {
    for (const [kind, re] of patterns) {
      const match = re.exec(lines[i]);
      if (!match || (symbol && match[1] !== symbol)) continue;
      found.push({ line: i + 1, kind, name: match[1], source: lines[i].trim() });
      break;
    }
  }
  return found;
}

export function omegaRead(args) {
  const list = Array.isArray(args.files) ? args.files
    : (args.path ? [{ path: args.path }] : null);
  if (!list || !list.length) {
    return { isError: true, text: 'files must be a non-empty array of {path, startLine?, lineCount?, pattern?, maxMatches?, contextBefore?, contextAfter?} (a plain path string also works)' };
  }
  // Relative paths resolve against baseDir, NOT the MCP server's own cwd: the
  // server is launched once with a fixed cwd while sessions come and go, so a
  // bare relative path silently resolved against the wrong root.
  const baseDir = path.resolve(
    args.baseDir || process.env.OMEGA_READ_BASE || process.cwd(),
  );
  const relMisses = [];
  const out = [];
  let total = 0;
  let okCount = 0;
  for (const item of list) {
    const spec = typeof item === 'string' ? { path: item } : (item || {});
    const p = spec.path;
    if (!p) { out.push('--- (spec without path, skipped) ---'); continue; }
    if (total >= READ_TOTAL_CAP) { out.push(`--- ${p} NOT READ: total cap ${READ_TOTAL_CAP} chars reached, narrow with startLine/lineCount/pattern ---`); continue; }
    const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
    if (!existsSync(abs)) {
      const why = path.isAbsolute(p)
        ? `${p} NOT FOUND`
        : `${p} NOT FOUND (relative to baseDir ${baseDir} -> ${abs}; pass an absolute path or set baseDir)`;
      if (!path.isAbsolute(p)) relMisses.push(p);
      out.push(`--- ${why} ---`);
      continue;
    }
    let st;
    try { st = statSync(abs); } catch (e) { out.push(`--- ${p} STAT FAILED: ${e.message} ---`); continue; }
    if (!st.isFile()) { out.push(`--- ${p} NOT A FILE ---`); continue; }
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch (e) { out.push(`--- ${p} READ FAILED: ${e.message} ---`); continue; }
    if (text.includes('\0')) { out.push(`--- ${p} BINARY (${st.size} bytes, skipped) ---`); continue; }
    const lines = text.split('\n');
    const remain = READ_TOTAL_CAP - total;
    let chunk;
    if ((spec.outline || spec.symbol) && spec.pattern) {
      out.push(`--- ${p} INVALID SPEC: pattern cannot be combined with outline/symbol ---`);
      continue;
    }
    if (spec.outline || spec.symbol) {
      const max = boundedInt(spec.maxSymbols, 100, 1, 300);
      const maxLineLength = boundedInt(spec.maxLineLength, 500, 1, 2000);
      const symbols = sourceOutline(p, lines, max, spec.symbol);
      const body = symbols.map((s) => `${s.line}: ${s.kind} ${s.name} | ${s.source.slice(0, maxLineLength)}`).join('\n');
      chunk = `=== ${p} heuristic outline${spec.symbol ? ` symbol=${spec.symbol}` : ''}: ${symbols.length} declaration(s) of ${lines.length} lines ===\n${body || '(no declarations found)'}`;
    } else if (spec.pattern) {
      let re;
      try { re = new RegExp(spec.pattern, 'im'); } catch (e) { out.push(`--- ${p} BAD PATTERN: ${e.message} ---`); continue; }
      const max = boundedInt(spec.maxMatches, READ_DEFAULT_MATCHES, 1, 100);
      const before = boundedInt(spec.contextBefore, 0, 0, 20);
      const after = boundedInt(spec.contextAfter, 0, 0, 20);
      const maxLineLength = boundedInt(spec.maxLineLength, 500, 1, 2000);
      const hitLines = [];
      for (let i = 0; i < lines.length && hitLines.length < max; i++) {
        if (re.test(lines[i])) hitLines.push(i);
      }
      let body;
      if (!before && !after) {
        body = hitLines.map((i) => `${i + 1}: ${lines[i].slice(0, maxLineLength)}`).join('\n');
      } else {
        const ranges = [];
        for (const i of hitLines) {
          const start = Math.max(0, i - before);
          const end = Math.min(lines.length - 1, i + after);
          const last = ranges[ranges.length - 1];
          if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
          else ranges.push({ start, end });
        }
        body = ranges.map(({ start, end }) => {
          const numbered = [];
          for (let i = start; i <= end; i++) numbered.push(`${i + 1}: ${lines[i].slice(0, maxLineLength)}`);
          return `--- lines ${start + 1}..${end + 1} ---\n${numbered.join('\n')}`;
        }).join('\n--\n');
      }
      const context = before || after ? ` context=-${before}/+${after}` : '';
      chunk = `=== ${p} pattern=/${spec.pattern}/ ${hitLines.length} match(es) of ${lines.length} lines${context} ===\n${body}`;
    } else {
      const start = Math.max((spec.startLine || 1) - 1, 0);
      const count = Math.min(spec.lineCount || READ_DEFAULT_LINES, READ_MAX_LINES);
      const slice = lines.slice(start, start + count);
      chunk = `=== ${p} lines ${start + 1}..${start + slice.length} of ${lines.length} ===\n${slice.join('\n')}`;
    }
    chunk = chunk.slice(0, remain);
    out.push(chunk);
    total += chunk.length;
    okCount++;
  }
  if (okCount === 0 && relMisses.length) {
    out.push(`\nHINT: ${relMisses.length} relative path(s) missed against baseDir ${baseDir}. `
      + 'The MCP server cwd is NOT the session directory. Retry with absolute paths, '
      + 'or pass baseDir=<the project dir> / set OMEGA_READ_BASE.');
  }
  return { isError: okCount === 0, text: `omega_read: ${okCount}/${list.length} file(s), ${total} chars (cap ${READ_TOTAL_CAP}${okCount ? `, base ${baseDir}` : ''})\n\n${out.join('\n\n')}` };
}

// ---------- omega_guard_check (dry-run) ----------
// Ask the guard before spending a real run: same inspectCommand as omega_batch,
// no execution. Returns PASS/REFUSE per command so the agent fixes the
// command_line first instead of failing a batch job.
export function omegaGuardCheck(args) {
  const list = Array.isArray(args.commands) ? args.commands
    : (args.command_line ? [args.command_line] : null);
  if (!list || !list.length) {
    return { isError: true, text: 'commands must be a non-empty array of command_line strings (or a single command_line)' };
  }
  const out = [];
  let refused = 0;
  list.forEach((cmd, i) => {
    const r = inspectCommand(cmd);
    if (r.ok) out.push(`[PASS] #${i + 1}: ${String(cmd).slice(0, 120)}`);
    else { refused++; out.push(`[REFUSE] #${i + 1}: ${r.problems.join('; ')}`); }
  });
  out.unshift(`guard_check: ${list.length - refused}/${list.length} pass`);
  return { isError: refused > 0, text: out.join('\n') };
}

// ---------- omega_grep (server-side search) ----------
// Recon currently costs a subagent plus one omega_read per file. A capped
// path:line search answers "where is X" in one call without touching context.
// ripgrep when present, grep -rn fallback (Oracle has no rg). Read-only.
const GREP_MAX_MATCHES = 100;
const GREP_TOTAL_CAP = 8000;
const GREP_CAPTURE_CAP = 250000;

// `dir` and `include` are the parameter names, but callers reach for the builtin
// grep/read names instead -- passing `path` here used to be silently ignored, so
// the search ran against baseDir (the server cwd) and returned a confident,
// completely unrelated result set. A wrong-but-plausible answer is worse than
// an error, so name the near-misses and refuse instead of guessing.
const GREP_ALIASES = { path: 'dir', file: 'include', glob: 'include' };

export function omegaGrep(args, opts = {}) {
  const pattern = args.pattern;
  if (!pattern) return Promise.resolve({ isError: true, text: 'pattern is required' });
  const wrong = Object.keys(GREP_ALIASES).filter((k) => args[k] !== undefined);
  if (wrong.length) {
    return Promise.resolve({
      isError: true,
      text: `unknown parameter(s) for omega_grep: ${wrong.join(', ')}. `
        + wrong.map((k) => `"${k}" -> use "${GREP_ALIASES[k]}"`).join('; ')
        + '. omega_grep searches with `dir` (directory to search) and `include` (glob filter); '
        + 'refusing rather than silently searching the wrong place.',
    });
  }
  const baseDir = path.resolve(args.baseDir || process.env.OMEGA_READ_BASE || process.cwd());
  const dir = path.isAbsolute(args.dir || '') ? args.dir : path.resolve(baseDir, args.dir || '.');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return Promise.resolve({ isError: true, text: `dir not found or not a directory: ${dir} (baseDir ${baseDir})` });
  }
  const max = boundedInt(args.maxMatches, 30, 1, GREP_MAX_MATCHES);
  const before = boundedInt(args.contextBefore, 0, 0, 5);
  const after = boundedInt(args.contextAfter, 0, 0, 5);
  const maxLineLength = boundedInt(args.maxLineLength, 500, 1, 2000);
  const asList = (value) => value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  const includes = asList(args.include).filter((v) => typeof v === 'string' && v);
  const excludes = asList(args.exclude).filter((v) => typeof v === 'string' && v);
  return new Promise((resolve) => {
    let useRg = false;
    // OMEGA_FORCE_GREP=1 exercises the fallback on a host that has rg. The two
    // engines must answer identically, so being able to pin the slow path is
    // what makes that claim testable instead of a hope -- and it is the only way
    // to reproduce an Oracle-side regex bug from the Mac. `opts.forceGrep` is the
    // in-process form used by the parity test (env is read at spawn time only).
    const forceGrep = opts.forceGrep === true || process.env.OMEGA_FORCE_GREP === '1';
    if (!forceGrep) {
      try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); useRg = true; } catch { /* fallback */ }
    }
    let cmd, cmdArgs;
    if (useRg) {
      cmdArgs = ['--line-number', '--no-heading', '--color=never', '-e', pattern];
      if (args.ignoreCase) cmdArgs.push('--ignore-case');
      if (args.literal) cmdArgs.push('--fixed-strings');
      if (args.word) cmdArgs.push('--word-regexp');
      if (before) cmdArgs.push('-B', String(before));
      if (after) cmdArgs.push('-A', String(after));
      for (const include of includes) cmdArgs.push('--glob', include);
      for (const exclude of excludes) cmdArgs.push('--glob', `!${exclude}`);
      cmdArgs.push('--', dir);
      cmd = 'rg';
    } else {
      // -E is mandatory, not an optimization: the documented contract is "regex
      // (rg) / pattern (grep fallback)", and the tool description promises rg
      // semantics. Without -E, grep applies BRE, where `a|b` is a literal pipe:
      // the call returns "(no matches)" and exit 1 for a file that DOES contain
      // both alternatives. A silent wrong answer is worse than an error, so the
      // fallback must speak the same regex dialect as the primary path.
      //
      // Exactly ONE matcher flag, never both. GNU grep >= 3.7 treats `-E -F` as
      // "conflicting matchers specified" and exits 2, while BSD grep silently
      // lets the last one win. Passing both therefore made literal:true work on
      // the Mac and fail on Oracle -- found 2026-09-30 by the Oracle pull, and
      // invisible to a Mac-only suite. -F already implies fixed strings, so
      // literal mode drops -E entirely; -w composes with either.
      cmdArgs = ['-rn', '-I'];
      if (args.literal) cmdArgs.push('-F');
      else cmdArgs.push('-E');
      if (args.ignoreCase) cmdArgs.push('-i');
      if (args.word) cmdArgs.push('-w');
      if (before) cmdArgs.push('-B', String(before));
      if (after) cmdArgs.push('-A', String(after));
      for (const include of includes) cmdArgs.push(`--include=${include}`);
      for (const exclude of excludes) {
        cmdArgs.push(`--exclude=${exclude}`);
        const dirPattern = exclude.replace(/\/\*\*.*$/, '').split('/').filter(Boolean).pop();
        if (dirPattern) cmdArgs.push(`--exclude-dir=${dirPattern}`);
      }
      cmdArgs.push('-e', pattern, '--', dir);
      cmd = 'grep';
    }
    const child = spawn(cmd, cmdArgs, { cwd: baseDir });
    if (process.env.OMEGA_GREP_TRACE === '1') {
      // Escape hatch for asserting on the exact argv across platforms. The
      // suite's output assertions cannot see this class of bug: BSD grep
      // tolerates a flag combination GNU grep rejects, so the same call passes
      // on the Mac and fails on Oracle. Dumping argv makes the difference
      // assertable in one place instead of re-discovered per host.
      process.stderr.write(`OMEGA_GREP_TRACE ${JSON.stringify([cmd, ...cmdArgs])}\n`);
    }
    let out = '';
    let err = '';
    let captureTruncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (d) => {
      const next = d.toString();
      const room = GREP_CAPTURE_CAP - out.length;
      if (room > 0) out += next.slice(0, room);
      if (next.length > room) captureTruncated = true;
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, 30000);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      if (timedOut) {
        finish({ isError: true, text: `omega_grep timed out after 30000ms via ${cmd} in ${dir}` });
        return;
      }
      // Both rg and grep use 1 for a clean no-match result and 2+ for errors.
      if (code !== 0 && code !== 1) {
        finish({
          isError: true,
          text: `omega_grep failed via ${cmd} (exit ${code}${signal ? `, signal ${signal}` : ''}) in ${dir}\n${err.slice(0, 1000) || '(no stderr)'}`,
        });
        return;
      }
      const all = out.split('\n').filter((l) => l.trim());
      const lines = [];
      let matches = 0;
      const availableMatches = all.filter((line) => /:\d+:/.test(line)).length;
      for (const line of all) {
        const isMatch = /:\d+:/.test(line);
        if (isMatch && matches >= max) break;
        if (isMatch) matches++;
        lines.push(line);
      }
      const text = lines.map((l) => l.slice(0, maxLineLength)).join('\n').slice(0, GREP_TOTAL_CAP);
      const truncated = captureTruncated || availableMatches > max || text.length >= GREP_TOTAL_CAP;
      const context = before || after ? `, context -B${before} -A${after}` : '';
      const summary = `omega_grep: ${matches} match(es)${truncated ? ' (truncated, narrow pattern/dir)' : ''}${context} via ${cmd} in ${dir}`;
      finish({ isError: false, text: `${summary}\n\n${text || '(no matches)'}` });
    });
    child.on('error', (e) => { clearTimeout(t); finish({ isError: true, text: e.message }); });
  });
}

// ---------- omega_quota (giz allowance snapshot) ----------
// Shells out to the same giz-quota script the skill uses (table output, capped).
// Script + cookie jar live on the Mac side; elsewhere this degrades to a
// pointer instead of failing obscurely. Never echoes credentials: the script
// reads its own jar, we only return its table.
export function omegaQuota() {
  const script = process.env.OMEGA_QUOTA_SCRIPT
    || path.join(homedir(), '.config/gencode/scripts/giz-quota.sh');
  if (!existsSync(script)) {
    return Promise.resolve({ isError: true, text: `quota check not configured on this host (missing ${script}). Run giz-quota on the Mac side.` });
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [script], {});
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 60000);
    child.on('close', (code) => {
      clearTimeout(t);
      const text = (out || err || '(no output)').slice(0, 6000);
      resolve({ isError: code !== 0, text: code === 0 ? text : `exit=${code}\n${text}` });
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ isError: true, text: e.message }); });
  });
}

// ---------- omega_health (mechanical self-check) ----------
// Turns "is my server fine?" into one call: syntax + hashes of the three
// modules, writable scratch dirs, db/rg/quota-script presence, node version.
// HEALTHY means serve-able; anything else lists exactly what is wrong.
export function omegaHealth() {
  const lines = [`node ${process.version} pid=${process.pid}`];
  let ok = true;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of ['server.mjs', 'tools-ext.mjs', 'batch-guard.mjs']) {
    const f = path.join(here, m);
    try {
      const buf = readFileSync(f);
      execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' });
      lines.push(`  [ok] ${m} sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 20)}`);
    } catch (e) { ok = false; lines.push(`  [FAIL] ${m} BROKEN: ${String((e && e.message) || e).split('\n')[0]}`); }
  }
  for (const [name, d] of [
    ['jobs', process.env.OMEGA_JOB_DIR || '/tmp/omega-jobs'],
    ['artifacts', process.env.OMEGA_ARTIFACT_DIR || path.join(homedir(), 'workspace/genspark-agent/server-v2/data/artifacts')],
  ]) {
    try { mkdirSync(d, { recursive: true }); lines.push(`  [ok] ${name} dir writable: ${d}`); }
    catch (e) { ok = false; lines.push(`  [FAIL] ${name} dir NOT writable: ${d} (${e.message})`); }
  }
  const db = process.env.OMEGA_DB || path.join(homedir(), 'workspace/genspark-agent/server-v2/data/agent.db');
  lines.push(`  [${existsSync(db) ? 'ok' : '--'}] agent db: ${existsSync(db) ? db : 'absent (db_query degrades gracefully)'}`);
  let rg = false;
  try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); rg = true; } catch { /* fallback */ }
  // Name the searched PATH and the dirs we would add: "absent" alone sent the
  // 2026-09-30 investigation down a wrong path (assumed rg uninstalled) when
  // the real cause was the server's minimal PATH.
  lines.push(`  [${rg ? 'ok' : '--'}] ripgrep: ${rg ? 'present (omega_grep full speed)'
    : `absent -> omega_grep uses the grep -E fallback (ERE, same dialect); searched PATH=${
      (process.env.PATH || '(unset)').split(pathSep).join(': ')}; add ${
      TOOL_DIRS.filter((d) => !(process.env.PATH || '').split(pathSep).includes(d)).join(', ') || '(already on PATH)'}`}`);
  const q = process.env.OMEGA_QUOTA_SCRIPT || path.join(homedir(), '.config/gencode/scripts/giz-quota.sh');
  lines.push(`  [${existsSync(q) ? 'ok' : '--'}] quota script: ${existsSync(q) ? q : 'absent (omega_quota points at Mac)'}`);
  lines.push(`  extras loaded: ${EXTRA_TOOLS.length} tool definitions`);
  lines.unshift(`health: ${ok ? 'HEALTHY' : 'DEGRADED'}`);
  return { isError: !ok, text: lines.join('\n') };
}

// ---------- omega_sqlite (any db, read-only, zero-dep) ----------
// db_query only knows the Mac agent.db via dbfile.cjs, which does not exist on
// Oracle -- so every query failed there regardless of SQL. This one takes the
// db path as a parameter and runs on the python3 stdlib sqlite3 module (both
// hosts have python3; Oracle has no sqlite3 CLI). Two locks: the same
// SELECT-only prefix check, plus PRAGMA query_only=ON inside the engine, plus
// a read-only URI open. opencode.db, agent.db, any sqlite file.
const SQLITE_MAX_ROWS = 200;
const SQLITE_TOTAL_CAP = 20000;

export function omegaSqlite(args) {
  let { db } = args;
  let sql = args.sql;
  if (args.sql_b64) sql = Buffer.from(args.sql_b64, 'base64').toString('utf8');
  if (!db) return Promise.resolve({ isError: true, text: 'db is required (path to a sqlite file, e.g. ~/.local/share/opencode/opencode.db)' });
  if (!sql) return Promise.resolve({ isError: true, text: 'sql or sql_b64 is required' });
  if (WRITE_RE.test(sql)) {
    return Promise.resolve({ isError: true, text: 'refused: SELECT / PRAGMA(question) / EXPLAIN / WITH only' });
  }
  if (String(db).startsWith('~/')) db = path.join(homedir(), String(db).slice(2));
  const abs = path.isAbsolute(db) ? db : path.resolve(args.baseDir || process.env.OMEGA_READ_BASE || process.cwd(), db);
  if (!existsSync(abs)) {
    return Promise.resolve({ isError: true, text: `db not found: ${abs}` });
  }
  const py = [
    'import json, sqlite3, sys',
    'db, sql = sys.argv[1], sys.argv[2]',
    "con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)",
    "con.execute('PRAGMA query_only=ON')",
    'cur = con.execute(sql)',
    'cols = [d[0] for d in cur.description] if cur.description else []',
    `rows = cur.fetchmany(${SQLITE_MAX_ROWS})`,
    'print(json.dumps({"columns": cols, "rows": [dict(zip(cols, r)) for r in rows]}, ensure_ascii=False, default=str))',
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', py, abs, sql], {});
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
    child.on('close', (code) => {
      clearTimeout(t);
      const text = (out || err || '(no output)').slice(0, SQLITE_TOTAL_CAP);
      resolve({ isError: code !== 0, text: code === 0 ? text : `exit=${code}\n${text}` });
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ isError: true, text: `no python3 on this host: ${e.message}` }); });
  });
}

// ---------- omega_edit (two-phase batch edit) ----------
// The edit version of the omega philosophy: N file edits computed in memory,
// every assertion verified, and only then ALL files written. One failure --
// missing oldString, ambiguous multi-match, mustContain miss -- aborts the
// whole batch with NOTHING WRITTEN, and every problem is reported at once so
// no round is wasted. Returns a per-file diff so judgment stays with the
// caller. By prompt-level rule this is the primary model's tool; subagents
// never touch files.
const EDIT_MAX_FILE = 500000;
const EDIT_DIFF_CAP = 3000;
const EDIT_TOTAL_CAP = 20000;

function editHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readUtf8Strict(abs) {
  const bytes = readFileSync(abs);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = bom ? bytes.subarray(3) : bytes;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new Error('file is not valid UTF-8; byte-preserving edit refused');
  }
  return { bytes, text, bom };
}

function encodeUtf8(text, bom) {
  const payload = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload]) : payload;
}

function dominantLineEnding(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  if (crlf && !lf) return '\r\n';
  if (lf && !crlf) return '\n';
  return null;
}

function normalizeLineEndings(text, eol) {
  return eol ? text.replace(/\r\n|\r|\n/g, eol) : text;
}

function miniDiff(oldText, newText, ctx = 3) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  if (s > ea && s > eb) return '(no line changes)';
  const lo = Math.max(0, s - ctx);
  const hiA = Math.min(a.length - 1, ea + ctx);
  const hiB = Math.min(b.length - 1, eb + ctx);
  const out = [`@@ lines ${lo + 1}..${hiA + 1} @@`];
  for (let i = lo; i <= hiA; i++) out.push(`${i >= s && i <= ea ? '- ' : '  '}${a[i].slice(0, 500)}`);
  out.push('---');
  for (let i = lo; i <= hiB; i++) out.push(`${i >= s && i <= eb ? '+ ' : '  '}${b[i].slice(0, 500)}`);
  return out.join('\n').slice(0, EDIT_DIFF_CAP);
}

// Hunk diff from known replacement spans (exact, no LCS needed):
// each span carries old/new text; context lines come from the final text.
function spanDiff(newText, spans, ctx = 3) {
  const lines = newText.split('\n');
  const starts = [0];
  for (let i = 0; i < newText.length; i++) if (newText[i] === '\n') starts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= pos) lo = m + 1; else hi = m; }
    return Math.max(0, lo - 1);
  };
  const ranges = spans.map((s) => {
    const endPos = s.len > 0 ? s.at + s.len - 1 : s.at;
    return {
      l0: Math.max(0, lineOf(s.at) - ctx),
      l1: Math.min(lines.length - 1, lineOf(endPos) + ctx),
      a0: lineOf(s.at), a1: lineOf(endPos),
      span: s,
    };
  }).sort((x, y) => x.l0 - y.l0 || x.a0 - y.a0);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.l0 <= last.l1 + 1) {
      last.l1 = Math.max(last.l1, r.l1);
      last.spans.push(r);
    } else merged.push({ l0: r.l0, l1: r.l1, spans: [r] });
  }
  const hunks = merged.map((h, hi) => {
    const byLine = new Map();
    for (const r of h.spans) for (let l = r.a0; l <= r.a1; l++) byLine.set(l, r.span);
    const out = [`@@ lines ${h.l0 + 1}..${h.l1 + 1} (hunk ${hi + 1}/${merged.length}) @@`];
    const emittedOld = new Set();
    for (let l = h.l0; l <= h.l1; l++) {
      const sp = byLine.get(l);
      if (sp && !emittedOld.has(sp)) {
        emittedOld.add(sp);
        for (const ol of sp.oldStr.split('\n')) out.push(`- ${ol.slice(0, 500)}`);
      }
      out.push(`${sp ? '+' : '  '}${(lines[l] ?? '').slice(0, 500)}`);
    }
    return out.join('\n');
  });
  let used = 0;
  const keptH = [];
  for (const hk of hunks) {
    if (used + hk.length > EDIT_DIFF_CAP && keptH.length) break;
    keptH.push(hk); used += hk.length;
  }
  if (keptH.length < hunks.length) keptH.push(`... (${hunks.length - keptH.length} more hunk(s) truncated, EDIT_DIFF_CAP=${EDIT_DIFF_CAP})`);
  return keptH.join('\n');
}

export function omegaEdit(args) {
  const list = Array.isArray(args.edits) ? args.edits : null;
  if (!list || !list.length) {
    return { isError: true, text: 'edits must be a non-empty array of {path, oldString, newString, replaceAll?, mustContain?, mustNotContain?}' };
  }
  const baseDir = path.resolve(args.baseDir || process.env.OMEGA_READ_BASE || process.cwd());
  const dctx = Math.min(15, Math.max(0, args.diffCtx ?? 3)); // context lines per diff hunk
  const createIfMissing = args.createIfMissing === true;
  const pending = new Map(); // abs -> { path, abs, orig, text }: same-file edits chain in order
  const report = [];
  let failed = 0;
  let applied = 0;
  // One undo point per call, so a whole batch of edits can be rolled back together.
  const batchId = `edit-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  for (let i = 0; i < list.length; i++) {
    const tag = `#${i + 1}`;
    const e = list[i] || {};
    const fail = (why) => { failed++; report.push(`[FAIL] ${tag} ${e.path || '(no path)'}: ${why}`); };
    if (!e.path || typeof e.oldString !== 'string' || typeof e.newString !== 'string') {
      fail('path/oldString/newString are all required'); continue;
    }
    if (e.oldString === e.newString) { fail('oldString and newString are identical (no-op)'); continue; }
    const abs = path.isAbsolute(e.path) ? e.path : path.resolve(baseDir, e.path);
    const fileExists = existsSync(abs);
    // An empty oldString is legal ONLY as the seed for a file that does not exist
    // yet. On an existing file it would match at every position, so the ambiguity
    // check below would reject it anyway -- say so here instead. This ordering
    // matters: an earlier blanket `if (!e.oldString)` guard made createIfMissing
    // unreachable, which is exactly the bug the regression suite caught.
    if (!e.oldString && fileExists) {
      fail('oldString is empty, which on an existing file matches everywhere; '
        + 'empty oldString is only accepted to create a missing file (createIfMissing:true)');
      continue;
    }
    if (!fileExists && !createIfMissing) {
      fail(`file not found: ${abs} (pass createIfMissing:true to scaffold a new file in the same two-phase commit)`);
      continue;
    }
    let entry = pending.get(abs);
    if (!entry) {
      let disk;
      let bom = false;
      let originalBytes = null;
      let originalIdentity = null;
      const isNew = !fileExists;
      if (isNew) {
        if (e.oldString !== '') {
          fail('file not found and oldString is not the empty string; a new file must start from oldString:""');
          continue;
        }
        disk = '';
      } else {
        try {
          const st = statSync(abs);
          if (!st.isFile()) { fail('not a file'); continue; }
          if (st.size > EDIT_MAX_FILE) { fail(`file too large (${st.size} bytes, cap ${EDIT_MAX_FILE})`); continue; }
          const decoded = readUtf8Strict(abs);
          disk = decoded.text;
          bom = decoded.bom;
          originalBytes = decoded.bytes;
          originalIdentity = { dev: st.dev, ino: st.ino };
        } catch (err) { fail(`read failed: ${err.message}`); continue; }
        if (disk.includes('\0')) { fail('binary file, refused'); continue; }
      }
      entry = {
        path: e.path,
        abs,
        orig: disk,
        text: disk,
        isNew,
        bom,
        eol: dominantLineEnding(disk),
        originalHash: isNew ? null : editHash(originalBytes),
        originalIdentity,
        originalMode: isNew ? null : statSync(abs).mode & 0o777,
        finalChecks: [],
      };
      pending.set(abs, entry);
    }
    if (e.expectedSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/i.test(e.expectedSha256)) {
        fail('expectedSha256 must be a 64-character hexadecimal SHA-256 digest'); continue;
      }
      if (entry.isNew) {
        fail('expectedSha256 cannot be used for a file that does not exist'); continue;
      }
      if (entry.originalHash !== e.expectedSha256.toLowerCase()) {
        fail(`expectedSha256 mismatch: expected ${e.expectedSha256.toLowerCase()}, found ${entry.originalHash}`); continue;
      }
    }
    const text = entry.text;
    const newString = args.preserveLineEndings === false ? e.newString : normalizeLineEndings(e.newString, entry.eol);
    if (e.oldString === newString) { fail('oldString and normalized newString are identical (no-op)'); continue; }
    const hits = text.split(e.oldString).length - 1;
    if (hits === 0) { fail('oldString not found (0 matches)'); continue; }
    if (hits > 1 && !e.replaceAll) { fail(`oldString matches ${hits} times, refusing to guess (pass replaceAll:true to replace every occurrence)`); continue; }
    const at = text.indexOf(e.oldString);
    // Overlap guard (same-file chaining): warn when this match lands inside a
    // region written by an earlier edit in this batch — usually a duplicated
    // oldString or a stale copy. Spans are tracked in evolving-text coordinates.
    const spans = entry.spans || (entry.spans = []);
    const matchEnd = at + e.oldString.length;
    const overlapped = spans.filter((s) => at < s.at + s.len && s.at < matchEnd);
    if (overlapped.length && !e.allowOverlap) {
      report.push(`[warn] ${tag} ${e.path}: oldString overlaps region written by ${overlapped.map((s) => s.tag).join(', ')} — chained anyway, verify intent (pass allowOverlap:true to silence)`);
    }
    const next = e.replaceAll ? text.split(e.oldString).join(newString)
      : text.slice(0, at) + newString + text.slice(at + e.oldString.length);
    const need = (v) => (Array.isArray(v) ? v : [v]);
    const missContain = e.mustContain !== undefined ? need(e.mustContain).filter((x) => !next.includes(x)) : [];
    if (missContain.length) { fail(`mustContain miss: ${missContain.join(', ')}`); continue; }
    const hitBan = e.mustNotContain !== undefined ? need(e.mustNotContain).filter((x) => next.includes(x)) : [];
    if (hitBan.length) { fail(`mustNotContain hit: ${hitBan.join(', ')}`); continue; }
    let mustMatch = [];
    let mustNotMatch = [];
    try {
      mustMatch = e.mustMatch !== undefined ? need(e.mustMatch).map((x) => new RegExp(x, 'm')) : [];
      mustNotMatch = e.mustNotMatch !== undefined ? need(e.mustNotMatch).map((x) => new RegExp(x, 'm')) : [];
    } catch (err) { fail(`invalid assertion regex: ${err.message}`); continue; }
    const missMatch = mustMatch.filter((re) => !re.test(next));
    if (missMatch.length) { fail(`mustMatch miss: ${missMatch.map(String).join(', ')}`); continue; }
    const hitMatch = mustNotMatch.filter((re) => re.test(next));
    if (hitMatch.length) { fail(`mustNotMatch hit: ${hitMatch.map(String).join(', ')}`); continue; }
    entry.text = next;
    entry.finalChecks.push({
      tag,
      mustContain: e.mustContain !== undefined ? need(e.mustContain) : [],
      mustNotContain: e.mustNotContain !== undefined ? need(e.mustNotContain) : [],
      mustMatch,
      mustNotMatch,
    });
    // Map pre-existing spans through this replacement (points ascending);
    // drop spans overlapping a replaced region. New spans carry both sides for hunk diffs.
    const oldLen = e.oldString.length, newLen = newString.length;
    let points;
    if (e.replaceAll) {
      points = [];
      let mi = text.indexOf(e.oldString);
      while (mi !== -1) { points.push(mi); mi = text.indexOf(e.oldString, mi + oldLen); }
    } else points = [at];
    const kept = [];
    for (const s of spans) {
      let shift = 0, dead = false;
      for (const p of points) {
        if (s.at + s.len <= p) break;
        if (s.at >= p + oldLen) shift += newLen - oldLen;
        else { dead = true; break; }
      }
      if (!dead) { s.at += shift; kept.push(s); }
    }
    if (e.replaceAll) {
      const parts = text.split(e.oldString);
      let npos = 0;
      for (let k = 0; k < parts.length - 1; k++) {
        npos += parts[k].length;
        kept.push({ at: npos, len: newLen, oldStr: e.oldString, newStr: newString, tag });
        npos += newLen;
      }
    } else kept.push({ at, len: newLen, oldStr: e.oldString, newStr: newString, tag });
    entry.spans = kept;
    applied++;
    report.push(`[ok] ${tag} ${e.path} (${e.replaceAll ? `${hits} replacements` : '1 replacement'})`);
  }
  // Re-run every assertion against the final chained text. A later edit cannot
  // silently invalidate a guarantee established by an earlier edit.
  for (const entry of pending.values()) {
    for (const check of entry.finalChecks) {
      const reasons = [];
      const missing = check.mustContain.filter((x) => !entry.text.includes(x));
      const banned = check.mustNotContain.filter((x) => entry.text.includes(x));
      const missingRe = check.mustMatch.filter((re) => !re.test(entry.text));
      const bannedRe = check.mustNotMatch.filter((re) => re.test(entry.text));
      if (missing.length) reasons.push(`mustContain miss: ${missing.join(', ')}`);
      if (banned.length) reasons.push(`mustNotContain hit: ${banned.join(', ')}`);
      if (missingRe.length) reasons.push(`mustMatch miss: ${missingRe.map(String).join(', ')}`);
      if (bannedRe.length) reasons.push(`mustNotMatch hit: ${bannedRe.map(String).join(', ')}`);
      if (reasons.length) {
        failed++;
        report.push(`[FAIL] ${check.tag} ${entry.path}: final assertion failed after chained edits: ${reasons.join('; ')}`);
      }
    }
    const outputBytes = encodeUtf8(entry.text, entry.bom).length;
    if (outputBytes > EDIT_MAX_FILE) {
      failed++;
      report.push(`[FAIL] ${entry.path}: output too large (${outputBytes} bytes, cap ${EDIT_MAX_FILE})`);
    }
  }
  if (failed) {
    // The per-edit [ok] lines below are VOID: two-phase commit means the whole
    // batch was discarded. Printing them as plain [ok] invited reading them as
    // "some edits landed", which is how a lost schema edit went unnoticed for
    // several turns. Say it in the same line the reader already looks at.
    const voided = report.map((r) => r.replace(/^\[ok\]/, '[void]'));
    return { isError: true, text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (two-phase commit) -- every [void] line below was NOT applied\n${voided.join('\n')}` };
  }
  const dry = args.dryRun === true;
  if (!dry) {
    // Re-read every target immediately before the first write. The edit planning
    // phase is synchronous but another process can still replace a file between
    // the initial read and commit; in that case the whole batch must fail closed.
    const stale = [];
    for (const entry of pending.values()) {
      if (entry.isNew) {
        if (existsSync(entry.abs)) stale.push(`${entry.path}: appeared after planning`);
        continue;
      }
      try {
        const currentStat = statSync(entry.abs);
        if (!currentStat.isFile()
          || currentStat.dev !== entry.originalIdentity.dev
          || currentStat.ino !== entry.originalIdentity.ino) {
          stale.push(`${entry.path}: file identity changed after planning`);
          continue;
        }
        const current = readFileSync(entry.abs);
        const currentHash = editHash(current);
        if (currentHash !== entry.originalHash) {
          stale.push(`${entry.path}: changed after planning (expected sha256 ${entry.originalHash}, found ${currentHash})`);
        }
      } catch (err) {
        stale.push(`${entry.path}: unavailable after planning (${err.message})`);
      }
    }
    if (stale.length) {
      const voided = report.map((r) => r.replace(/^\[ok\]/, '[void]'));
      const failures = stale.map((s) => `[FAIL] ${s}`);
      return {
        isError: true,
        text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (stale-file protection) -- every [void] line below was NOT applied\n${[...voided, ...failures].join('\n')}`,
      };
    }
    // Stage every output before touching originals. rename is atomic per file;
    // the manifest is durable before the first rename so crashes remain undoable.
    const staged = [];
    try {
      for (const entry of pending.values()) {
        const bytes = encodeUtf8(entry.text, entry.bom);
        if (bytes.length > EDIT_MAX_FILE) throw new Error(`${entry.path}: output too large (${bytes.length} bytes, cap ${EDIT_MAX_FILE})`);
        mkdirSync(path.dirname(entry.abs), { recursive: true });
        const temp = path.join(path.dirname(entry.abs), `.${path.basename(entry.abs)}.omega-${batchId}-${staged.length}.tmp`);
        writeFileSync(temp, bytes, entry.originalMode === null ? undefined : { mode: entry.originalMode });
        if (entry.originalMode !== null) chmodSync(temp, entry.originalMode);
        staged.push({ entry, temp });
      }
    } catch (err) {
      for (const item of staged) try { rmSync(item.temp, { force: true }); } catch {}
      return { isError: true, text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (staging failed): ${err.message}` };
    }
    try {
      for (const { entry } of staged) {
        if (entry.isNew) snapshotMissing(entry.abs, batchId);
        else snapshotFile(entry.abs, batchId);
      }
      persistSnapManifest(batchId, snapStats.get(batchId) || []);
    } catch (err) {
      for (const item of staged) try { rmSync(item.temp, { force: true }); } catch {}
      snapStats.delete(batchId);
      return { isError: true, text: `edit: FAILED ${applied}/${list.length}, NOTHING WRITTEN (snapshot failed): ${err.message}` };
    }
    const landed = [];
    try {
      for (const item of staged) {
        renameSync(item.temp, item.entry.abs);
        landed.push(item.entry.path);
      }
    } catch (err) {
      const rollbackErrors = [];
      for (const snap of (snapStats.get(batchId) || []).slice(0, landed.length)) {
        try { restoreOne(snap); } catch (rollbackErr) { rollbackErrors.push(`${snap.path}: ${rollbackErr.message}`); }
      }
      for (const item of staged) try { rmSync(item.temp, { force: true }); } catch {}
      return {
        isError: true,
        text: `edit: COMMIT FAILED after ${landed.length}/${staged.length} file(s); snapshots restored${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join('; ')}` : ''}: ${err.message}`,
      };
    }
    report.push(`undo point: ${batchId} (omega_undo {"batchId":"${batchId}"} to roll back ${landed.length} file(s))`);
  }
  const diffs = [...pending.values()].map((s) => `--- ${s.path} ---\n${s.spans && s.spans.length ? spanDiff(s.text, s.spans, dctx) : miniDiff(s.orig, s.text, dctx)}`);
  return { isError: false, text: `edit: ${applied}/${list.length} ${dry ? 'verified (DRY-RUN, NOTHING WRITTEN)' : 'applied (two-phase commit)'}\n${report.join('\n')}\n\n${diffs.join('\n\n')}`.slice(0, EDIT_TOTAL_CAP) };
}

export const EXTRA_TOOLS = [
  {
    name: 'omega_read',
    description: 'Read MANY files in ONE call. Each entry takes path plus an optional '
       + 'startLine/lineCount slice and/or a pattern regex filter (returns numbered '
       + 'matches with optional bounded context), or a heuristic declaration outline/symbol lookup. Packs recon that would cost 9 separate Read calls into one; output '
      + 'capped at 20000 chars with per-file headers showing line ranges. '
      + 'Prefer absolute paths, or set baseDir: relative paths resolve against the server '
      + 'cwd, not the session directory.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'list of {path, startLine? (1-indexed), lineCount? (max 500), pattern? (regex), maxMatches?, contextBefore?, contextAfter?}; a plain path string also works',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'integer' },
              lineCount: { type: 'integer' },
              pattern: { type: 'string' },
              maxMatches: { type: 'integer' },
              contextBefore: { type: 'integer', description: 'lines before each pattern match (default 0, max 20)' },
              contextAfter: { type: 'integer', description: 'lines after each pattern match (default 0, max 20)' },
              maxLineLength: { type: 'integer', description: 'maximum characters emitted per line (default 500, max 2000)' },
              outline: { type: 'boolean', description: 'return a heuristic declaration outline instead of a line slice; cannot be combined with pattern' },
              symbol: { type: 'string', description: 'return heuristic declaration entries with this exact symbol name; implies outline mode' },
              maxSymbols: { type: 'integer', description: 'maximum outline declarations (default 100, max 300)' },
            },
          },
        },
        path: { type: 'string', description: 'shorthand for reading a single file' },
        baseDir: { type: 'string', description: 'directory that relative paths resolve against (default: OMEGA_READ_BASE or the server cwd). The server cwd is NOT the session directory, so pass this when using relative paths.' },
      },
    },
  },
  {
    name: 'vfs_local_write',
    description: 'Write a file directly without shell quoting. Exactly one of content, content_b64, or content_file is accepted; base64 and file sources remain byte-exact. Non-append writes use a same-directory temporary file and atomic rename. expectedSha256 and requireMissing protect against unintended overwrite.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        content_b64: { type: 'string' },
        content_file: { type: 'string' },
        append: { type: 'boolean' },
        expectedSha256: { type: 'string', description: 'require an existing target with this SHA-256 before writing' },
        requireMissing: { type: 'boolean', description: 'refuse if the target already exists; rechecked immediately before replacement' },
      },
      required: ['path'],
    },
  },
  {
    name: 'omega_undo',
    description: 'Roll back the files an omega_edit call wrote, using the undo point it '
      + 'reported. Every omega_edit snapshots each target file before writing (and records '
      + 'files it created, which are deleted rather than blanked on undo). This is the '
      + 'cross-call safety net that the two-phase commit cannot give you: the commit only '
      + 'protects one call, this protects the next one from being wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        batchId: { type: 'string', description: 'the undo point id from the omega_edit result' },
        paths: { type: 'array', items: { type: 'string' }, description: 'optional subset of absolute paths to restore' },
        dryRun: { type: 'boolean', description: 'report what would be restored without touching disk' },
      },
      required: ['batchId'],
    },
  },
  {
    name: 'db_query',
    description: 'SQL against the agent database (commands history, memory/forged '
      + 'rules, lessons, playbook, scripts, skills, local_store). Reads are unrestricted '
      + '(SELECT/PRAGMA/EXPLAIN/WITH). Writes: INSERT/UPDATE/REPLACE/DELETE only, on the '
      + 'whitelisted tables, and only via INSERT/UPDATE/REPLACE/DELETE -- DDL, PRAGMA '
      + 'assignment, attach and vacuum are refused even with a snapshot. Every write is '
      + 'preceded by a real sqlite3 .backup snapshot and followed by integrity_check plus a '
      + 'row-count delta; the receipt names the rollback command. dryRun:true validates the '
      + 'fence and EXPLAINs the statement without applying it.'
      + (DB_WRITES ? '' : ' NOTE: this host runs read-only (OMEGA_DB_WRITES is not 1). '
        + 'Writes are refused. dryRun is unavailable.'),
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SELECT / PRAGMA / EXPLAIN / WITH, or INSERT/UPDATE/REPLACE/DELETE on a whitelisted table' },
        sql_b64: { type: 'string', description: 'base64 of the SQL, for multi-line queries' },
        ...(DB_WRITES ? { dryRun: { type: 'boolean', description: 'validate a write and report the plan without writing anything' } } : {}),
      },
    },
  },
  {
    name: 'omega_batch',
    description: "Run several bash steps in one call with mechanical acceptance checks. That is the point of this tool: a zero exit code only proves the command ran, not that it did what you wanted, so each step may carry expect.contains / expect.notContains / expect.regex and is reported FAIL when the assertion does not hold even though exit=0. Runs async: the call returns a job id immediately, then poll omega_batch_status for the verdict. With stopOnError (default true) the first failing step halts the rest, so order steps to put the cheap check before the destructive action. Prefer one batch over a series of separate commands when the steps belong to the same intent.",
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: "ordered list of steps, run in sequence; each needs command_line and may add label, timeout, cwd, stdin and expect",
          items: {
            type: 'object',
            properties: {
              command_line: { type: 'string', description: 'bash command for this step' },
              label: { type: 'string', description: 'short human-readable intent, shown in the status report; write it so the log is readable later' },
              timeout: { type: 'string', description: "per-step limit, \"30s\" / \"5m\" or milliseconds; the step is marked timedOut and fails" },
              cwd: { type: 'string', description: "working directory for this step; set it here instead of prefixing the command with cd" },
              stdin: { type: 'string', description: "text piped to the command stdin, which avoids shell quoting for content with quotes, $ or newlines" },
              expect: {
                description: "acceptance check applied to this step output; without it a step only fails on a non-zero exit code",
                type: 'object',
                properties: {
                  contains: { type: 'array', items: { type: 'string' }, description: 'every string must appear in the output, else the step is FAIL; use a token the command only prints on success, not a word that also shows up in normal reports' },
                  notContains: { type: 'array', items: { type: 'string' }, description: 'none of these may appear; keep them narrow, a broad word like MISSING also occurs in healthy output and causes false failures' },
                  regex: { type: 'string', description: 'output must match this regular expression' },
                },
              },
            },
            required: ['command_line'],
          },
        },
        stopOnError: { type: 'boolean', description: 'default true: halt remaining steps once one fails its expect or exits non-zero' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'omega_batch_status',
    description: "Fetch the result of an omega_batch job. Returns a summary line (\"failed 2/3\"), then one line per step marked [ok] or [FAIL] with the assertion that failed; steps not run because of stopOnError appear as (halted). Pass waitMs (max 50000) to block until the job settles and get the verdict in ONE call instead of submit-then-poll; if the wait elapses first it returns the current running state. verbose:true adds each step full captured output plus exit code, signal and timedOut.",
    inputSchema: {
      type: 'object',
      properties: {
          id: { type: 'string', description: 'job id returned by omega_batch, e.g. job-abc123' },
          waitMs: {
            type: 'number',
            description: 'block up to N ms (max 50000) waiting for the job to finish, so the verdict '
              + 'comes back in this same call. Deliberately capped below the host MCP timeout: a host '
              + 'that cuts the call at 60s would lose the reply entirely.',
          },
          verbose: { type: 'boolean', description: 'include full stdout/stderr of every step instead of just the pass/fail lines' },
          format: { type: 'string', enum: ['text', 'json'], description: 'response format (default text); json returns structured job and per-step fields' },
        },
      required: ['id'],
    },
  },
  {
    name: 'omega_batch_cancel',
    description: 'Request cancellation of a running omega_batch job. The currently active process is allowed to finish; no later step will start. This is cooperative cancellation, not process termination.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'running job id returned by omega_batch' },
      },
      required: ['id'],
    },
  },
  {
    name: 'omega_guard_check',
    description: 'Dry-run the omega_batch guard without executing anything. Pass the command_lines you intend to run; each is reported PASS or REFUSE with the reason. Use this before omega_batch when a step might write outside /tmp.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'array', items: { type: 'string' }, description: 'command_line strings to vet' },
        command_line: { type: 'string', description: 'shorthand for a single command' },
      },
    },
  },
  {
    name: 'omega_grep',
    description: 'Server-side code search returning capped path:line matches with optional bounded context. Supports regex or literal/whole-word matching plus include/exclude globs. ripgrep when available, grep -rn fallback. Read-only; use to locate code before omega_read.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regex (rg) / pattern (grep fallback)' },
        dir: { type: 'string', description: 'where to search; relative paths resolve against baseDir' },
        baseDir: { type: 'string', description: 'directory that relative paths resolve against' },
        include: { description: 'glob filter or array of globs, e.g. "*.mjs"', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        exclude: { description: 'glob or array of globs to exclude', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        ignoreCase: { type: 'boolean' },
        literal: { type: 'boolean', description: 'treat pattern as a fixed string rather than a regular expression' },
        word: { type: 'boolean', description: 'match whole words only' },
        maxMatches: { type: 'integer', description: 'default 30, max 100' },
        contextBefore: { type: 'integer', description: 'context lines before each match (default 0, max 5)' },
        contextAfter: { type: 'integer', description: 'context lines after each match (default 0, max 5)' },
        maxLineLength: { type: 'integer', description: 'maximum characters emitted per result line (default 500, max 2000)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'omega_quota',
    description: 'Giz model allowance snapshot (used/limit per model, reset times) via the giz-quota script. Only configured where the script + cookie jar exist (Mac); elsewhere returns a pointer instead of failing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'omega_health',
    description: 'Mechanical self-check: module syntax + hashes, writable scratch dirs, db/rg/quota-script presence, node version. Verdict on the first line.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'omega_sqlite',
    description: 'Read-only SQL against ANY sqlite file (opencode.db, agent.db). Takes the db path as a parameter; runs on the python3 stdlib sqlite3 module so it works where no sqlite3 CLI exists. SELECT/PRAGMA/EXPLAIN/WITH only, read-only open, max 200 rows.',
    inputSchema: {
      type: 'object',
      properties: {
        db: { type: 'string', description: "path to the sqlite file, e.g. ~/.local/share/opencode/opencode.db" },
        sql: { type: 'string', description: 'SELECT / PRAGMA / EXPLAIN / WITH only' },
        sql_b64: { type: 'string', description: 'base64 of the SQL, for multi-line queries' },
        baseDir: { type: 'string', description: 'directory that relative db paths resolve against' },
      },
      required: ['db'],
    },
  },
  {
    name: 'omega_edit',
    description: "Batch UTF-8 file edits with a two-phase commit: N edits are computed in memory, final string/regex assertions verified, target identity/content rechecked, all outputs staged, and only then atomically replaced per file. UTF-8 BOM, consistent line endings, and existing file modes are preserved. Same-file edits chain in order; overlapping matches emit a [warn] (pass allowOverlap:true to silence). One failure aborts everything with NOTHING WRITTEN. Returns a per-file diff. Pass dryRun:true to verify + preview diffs without writing. Primary model only; subagents never touch files.",
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'list of {path, oldString, newString, replaceAll?, mustContain?, mustNotContain?, allowOverlap?}; oldString must match exactly once unless replaceAll:true',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldString: { type: 'string' },
              newString: { type: 'string' },
              replaceAll: { type: 'boolean' },
              mustContain: { type: 'array', items: { type: 'string' } },
              mustNotContain: { type: 'array', items: { type: 'string' } },
              mustMatch: { type: 'array', items: { type: 'string' }, description: 'regular expressions that must match after this edit and in the final file' },
              mustNotMatch: { type: 'array', items: { type: 'string' }, description: 'regular expressions that must not match after this edit or in the final file' },
              allowOverlap: { type: 'boolean', description: 'silence the overlap warning for this edit' },
              expectedSha256: { type: 'string', description: 'optional SHA-256 precondition for the original target content' },
            },
            required: ['path', 'oldString', 'newString'],
          },
        },
        dryRun: { type: 'boolean', description: 'verify all edits and return diffs without writing anything' },
        preserveLineEndings: { type: 'boolean', description: 'normalize replacement newlines to a consistently CRLF/LF target (default true)' },
        diffCtx: { type: 'number', description: 'context lines around each change hunk in returned diffs (default 3, max 15)' },
        createIfMissing: {
          type: 'boolean',
          description: 'allow oldString:"" to scaffold a file that does not exist yet, so create+fill '
            + 'happens inside the same two-phase commit. A brand-new file must start from the empty '
            + 'string or the edit is rejected. Undo deletes created files rather than blanking them.',
        },
        baseDir: { type: 'string', description: 'directory that relative paths resolve against' },
      },
      required: ['edits'],
    },
  },
];
