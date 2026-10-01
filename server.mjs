#!/usr/bin/env node
// Forge MCP bridge: exposes the server-v2 shell driver to MCP hosts (opencode, etc.)
// Stage 1 scope: run_process only, plus artifact read/search so long output stays
// out of the model context. Deliberately no db writes yet.
//
// Protocol: JSON-RPC 2.0 over stdio, newline-delimited. Implemented directly so
// this has zero npm dependencies and cannot be broken by a missing node_modules.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  vfsLocalWrite, dbQuery, omegaBatch, omegaBatchStatus, omegaBatchCancel, omegaRead,
  omegaGuardCheck, omegaGrep, omegaQuota, omegaHealth, omegaSqlite, omegaEdit, omegaUndo, EXTRA_TOOLS,
} from './tools-ext.mjs';
import { createFlowRuntime, FLOW_TOOL } from './omega-flow.mjs';

const ART_DIR = process.env.OMEGA_ARTIFACT_DIR
  || path.join(homedir(), 'workspace/genspark-agent/server-v2/data/artifacts');
const INLINE_LIMIT = Number(process.env.OMEGA_INLINE_LIMIT || 20000);
const DEFAULT_TIMEOUT = Number(process.env.OMEGA_DEFAULT_TIMEOUT || 120000);
const LOG = process.env.OMEGA_MCP_LOG || '/tmp/omega-mcp.log';

function log(msg) {
  try {
    writeFileSync(LOG, `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch { /* logging must never break the server */ }
}

function saveArtifact(text, stream) {
  mkdirSync(ART_DIR, { recursive: true, mode: 0o700 });
  const sha = createHash('sha256').update(text).digest('hex');
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${sha.slice(0, 16)}`;
  const file = path.join(ART_DIR, `${id}.${stream}.txt`);
  writeFileSync(file, text, { mode: 0o600 });
  return { id, sha256: sha, file, ref: `artifact://${id}/${stream}` };
}

function resolveRef(ref) {
  const m = String(ref || '').match(/^artifact:\/\/([^/]+)\/(\w+)$/);
  if (!m) throw new Error(`bad artifact ref: ${ref}`);
  const file = path.join(ART_DIR, `${m[1]}.${m[2]}.txt`);
  if (!existsSync(file)) throw new Error(`artifact not found: ${ref}`);
  return file;
}

// Batch shells inherit a minimal PATH from the host (GenCode launches this
// server without Homebrew dirs), so bare `node`/`python3` died with 127 —
// found 2026-09-30 when a config-parse step failed `node: command not found`.
// Prepend well-known tool dirs; a caller-supplied PATH still wins via spread.
function withToolPath(env) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
    .filter((p) => !(env.PATH || '').split(sep).includes(p));
  if (!extra.length) return env;
  return { ...env, PATH: [...extra, env.PATH || ''].filter(Boolean).join(sep) };
}

function runProcess(args) {
  const cmd = args.command_line || args.command;
  if (!cmd) return Promise.resolve({ isError: true, text: 'command_line is required' });
  const timeout = parseDuration(args.timeout) ?? DEFAULT_TIMEOUT;
  const cwd = args.cwd || process.env.OMEGA_CWD || homedir();

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      env: withToolPath({ ...process.env, ...(args.environment || {}) }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    if (args.stdin) child.stdin.write(String(args.stdin));
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const combined = out + (err ? (out ? '\n--- stderr ---\n' : '') + err : '');
      const ok = !timedOut && code === 0;
      let body = combined;
      let banner = '';
      if (combined.length > INLINE_LIMIT) {
        const art = saveArtifact(combined, 'combined');
        const lines = combined.split('\n');
        const head = lines.slice(0, 40).join('\n');
        const tail = lines.slice(-80).join('\n');
        // Reference goes FIRST: a host that truncates trailing text must not eat it.
        banner = `[truncated] full output: ${art.ref} `
          + `(${combined.length} chars, ${lines.length} lines, sha256 ${art.sha256.slice(0, 12)})\n`
          + `Use artifact_search to locate content, artifact_read to fetch a slice.\n\n`;
        body = `${head}\n\n... [${lines.length - 120} lines omitted] ...\n\n${tail}`;
      }
      const status = `exit=${code} signal=${signal || 'none'} timedOut=${timedOut} `
        + `chars=${combined.length}\n`;
      resolve({
        isError: !ok,
        text: banner + status + body,
        exitCode: code,
        signal: signal || null,
        timedOut,
      });
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        isError: true,
        text: `spawn failed: ${e.message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
      });
    });
  });
}

function parseDuration(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v < 1000 && v > 0 ? v * 1000 : v;
  const m = String(v).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 'ms'];
  return Math.round(n * mult);
}

const TOOLS = [
  {
    name: 'run_process',
    description: 'Run a bash command. Long output is saved to an artifact and only a '
      + 'head/tail preview is returned; the artifact:// reference appears at the start '
      + 'of the response. Supports timeout as "30s"/"5m" or milliseconds, and stdin to '
      + 'pass content without shell quoting.',
    inputSchema: {
      type: 'object',
      properties: {
        command_line: { type: 'string', description: 'bash command to execute' },
        timeout: { type: 'string', description: 'e.g. "30s", "5m", or ms as number' },
        cwd: { type: 'string', description: 'working directory' },
        stdin: { type: 'string', description: 'text piped to the command stdin' },
      },
      required: ['command_line'],
    },
  },
  {
    name: 'artifact_read',
    description: 'Read a slice of a saved artifact by character offset or by line range.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'artifact://<id>/<stream>' },
        offset: { type: 'integer' },
        limit: { type: 'integer', description: 'max chars, default 20000' },
        startLine: { type: 'integer' },
        lineCount: { type: 'integer' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'artifact_search',
    description: 'Search the full text of an artifact with a regex and return matches with context.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        regex: { type: 'string' },
        contextChars: { type: 'integer', description: 'default 200' },
        maxMatches: { type: 'integer', description: 'default 10' },
      },
      required: ['ref', 'regex'],
    },
  },
];

// 2026-09-27: opencode already has read/write/edit/shell and does them better, so
// advertising ours only invites conflicting instructions. These survive because
// they have no builtin equivalent: omega_batch(_status) for mechanical
// verification, omega_read for MANY-files-in-one-call recon (builtin Read is
// one file per call), artifact_read/search as the retrieval half of batch
// overflow (batch output beyond 4000 chars/step would otherwise be unrecoverable),
 // db_query (reads free; DML writes fenced by table whitelist + auto .backup) for
 // history archaeology and lesson/playbook persistence where no sqlite3 exists (Oracle),
// omega_grep for one-call path:line search, omega_guard_check as a batch dry-run,
// omega_quota for allowance snapshots, omega_health as a mechanical self-check,
// omega_sqlite for read-only SQL against any sqlite file (db path is a
// parameter; python3 stdlib engine, works where no sqlite3 CLI exists),
 // omega_edit for two-phase batch edits (all verified in memory, then all
 // written; primary model only, subagents never touch files), plus omega_undo
 // to roll back a written batch by its undo point,
// vfs_local_write for quote-proof file writes (base64/content_file, no shell).
// Note: MCP calls are permission-checked under their own action name, so an
// edit:deny on the caller does NOT cover vfs_local_write / omega_edit --
// approving them is a conscious act under their own names, and the
// primary-only rule for writes lives in the prompts, not in code.
// To take one back, remove its name from this set rather than restoring code.
const OMEGA_ADVERTISE = new Set(["omega_batch", "omega_batch_status", "omega_batch_cancel", "omega_read", "artifact_read", "artifact_search", "db_query", "omega_guard_check", "omega_grep", "omega_quota", "omega_health", "vfs_local_write", "omega_sqlite", "omega_edit", "omega_undo"]);
OMEGA_ADVERTISE.add('omega_flow');
const ALL_TOOLS = [...TOOLS, ...EXTRA_TOOLS, FLOW_TOOL].filter((t) => OMEGA_ADVERTISE.has(t.name));
// Flow capacity is bounded so a chatty model cannot grow the jobs map without
// limit. Jobs are only reclaimed by the 30-minute TTL sweep and cancel does NOT
// free a slot, so a session that opens maxJobs flows is locked out until they
// expire. OMEGA_FLOW_MAX_JOBS tunes the ceiling; an unparseable value falls back
// to the default rather than silently lifting the bound.
const FLOW_MAX_JOBS_DEFAULT = 16;
const FLOW_MAX_JOBS_LIMIT = 1024;
const flowMaxJobs = (() => {
  const raw = process.env.OMEGA_FLOW_MAX_JOBS;
  if (raw === undefined || raw === '') return FLOW_MAX_JOBS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > FLOW_MAX_JOBS_LIMIT) {
    log(`omega_flow: ignoring OMEGA_FLOW_MAX_JOBS=${JSON.stringify(raw)}; want an integer 1..${FLOW_MAX_JOBS_LIMIT}`);
    return FLOW_MAX_JOBS_DEFAULT;
  }
  return n;
})();
const omegaFlow = createFlowRuntime(callTool, {
  allowEffects: process.env.OMEGA_FLOW_ALLOW_EFFECTS === '1',
  maxJobs: flowMaxJobs,
});

async function callTool(name, args) {
  if (name === 'omega_flow') return omegaFlow(args || {});
  if (name === 'run_process') return runProcess(args || {});

  if (name === 'vfs_local_write') return vfsLocalWrite(args || {});
  if (name === 'db_query') return dbQuery(args || {});
  if (name === 'omega_batch') return omegaBatch(args || {}, runProcess);
  if (name === 'omega_batch_status') return omegaBatchStatus(args || {});
  if (name === 'omega_batch_cancel') return omegaBatchCancel(args || {});
  if (name === 'omega_read') return omegaRead(args || {});
  if (name === 'omega_guard_check') return omegaGuardCheck(args || {});
  if (name === 'omega_grep') return omegaGrep(args || {});
  if (name === 'omega_quota') return omegaQuota(args || {});
  if (name === 'omega_health') return omegaHealth(args || {});
  if (name === 'omega_sqlite') return omegaSqlite(args || {});
  if (name === 'omega_edit') return omegaEdit(args || {});
  if (name === 'omega_undo') return omegaUndo(args || {});

  if (name === 'artifact_read') {
    const file = resolveRef(args.ref);
    const text = readFileSync(file, 'utf8');
    if (args.startLine !== undefined) {
      const lines = text.split('\n');
      const s = Math.max(0, args.startLine - 1);
      const slice = lines.slice(s, s + (args.lineCount || 100)).join('\n');
      return { isError: false, text: `lines ${s + 1}..${s + (args.lineCount || 100)} of ${lines.length}\n\n${slice}` };
    }
    const off = args.offset || 0;
    const lim = Math.min(args.limit || 20000, 200000);
    return { isError: false, text: `chars ${off}..${off + lim} of ${text.length}\n\n${text.slice(off, off + lim)}` };
  }

  if (name === 'artifact_search') {
    const file = resolveRef(args.ref);
    const text = readFileSync(file, 'utf8');
    const re = new RegExp(args.regex, 'gim');
    const ctx = args.contextChars || 200;
    const max = args.maxMatches || 10;
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null && hits.length < max) {
      const s = Math.max(0, m.index - ctx);
      hits.push(`@${m.index} [${m[0].slice(0, 60)}]\n${text.slice(s, m.index + m[0].length + ctx)}`);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { isError: false, text: `${hits.length} match(es) in ${text.length} chars\n\n${hits.join('\n---\n')}` };
  }

  return { isError: true, text: `unknown tool: ${name}` };
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    log(`parse error: ${e.message}`);
    return;
  }
  const { id, method, params } = req;
  log(`-> ${method}`);
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'forge-bridge', version: '0.8.1' },
        },
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification: no response
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: ALL_TOOLS } });
    } else if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: r.text }], isError: r.isError },
      });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    log(`error in ${method}: ${e.stack || e.message}`);
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message) } });
    }
  }
});

log(`omega-bridge started pid=${process.pid} artifacts=${ART_DIR}`);
