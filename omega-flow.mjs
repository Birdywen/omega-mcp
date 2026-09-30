// Small JSON orchestration runtime. No eval, interpolation, nested flows or retries.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { awaitBatch, flowError } from './omega-flow-wait.mjs';

const READ = new Set(['omega_read', 'omega_grep', 'omega_guard_check', 'omega_health',
  'omega_quota', 'omega_sqlite', 'omega_batch_status', 'artifact_read', 'artifact_search']);
const EFFECT = new Set(['omega_edit', 'omega_undo', 'omega_batch', 'omega_batch_cancel']);
const BAD = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BYTES = 256_000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

function safe(value, depth = 0) {
  if (depth > 24) throw Error('JSON nesting exceeds 24');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') throw Error('JSON values only');
  for (const [key, child] of Object.entries(value)) {
    if (BAD.has(key)) throw Error(`forbidden key: ${key}`);
    safe(child, depth + 1);
  }
}

function reference(path, context) {
  if (typeof path !== 'string' || !/^(vars|steps)(\.[A-Za-z0-9_-]+)+$/.test(path)) throw Error(`invalid ref: ${path}`);
  let value = context;
  for (const part of path.split('.')) {
    if (BAD.has(part) || value === null || typeof value !== 'object' || !own(value, part)) throw Error(`missing ref: ${path}`);
    value = value[part];
  }
  // Copy: a called tool cannot mutate the stored result or input variables.
  return structuredClone(value);
}

function resolve(value, context, budget = { left: MAX_BYTES }) {
  const charge = (v) => {
    budget.left -= bytes(v);
    if (budget.left < 0) throw Error('resolved value exceeds 256 KB');
    return v;
  };
  if (Array.isArray(value)) { charge([]); return value.map((v) => resolve(v, context, budget)); }
  if (!object(value)) return charge(value);
  if (own(value, '$literal')) {
    if (Object.keys(value).length !== 1) throw Error('$literal must be the only key');
    charge(value.$literal);
    return structuredClone(value.$literal);
  }
  if (own(value, '$ref')) {
    if (Object.keys(value).length !== 1) throw Error('$ref must be the only key');
    return charge(reference(value.$ref, context));
  }
  charge(Object.keys(value));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, context, budget)]));
}

function condition(test, context, assert = false) {
  const left = resolve(test.left, context), right = resolve(test.right, context);
  const details = { op: test.op, left: preview(left), right: preview(right) };
  let passed;
  if (test.op === 'eq') passed = isDeepStrictEqual(left, right);
  else if (test.op === 'ne') passed = !isDeepStrictEqual(left, right);
  else if (test.op === 'contains') {
    if (typeof left === 'string' && typeof right === 'string') passed = left.includes(right);
    else if (Array.isArray(left)) passed = left.some((v) => isDeepStrictEqual(v, right));
    else throw flowError('condition_type', 'contains requires strings or a left array', details);
  } else {
    if (typeof left !== 'number' || typeof right !== 'number') throw flowError('condition_type', 'ordered comparisons require numbers', details);
    passed = test.op === 'gt' ? left > right : test.op === 'gte' ? left >= right : test.op === 'lt' ? left < right : left <= right;
  }
  if (assert && !passed) throw flowError('assertion_failed', 'assertion failed', details);
  return passed;
}

function preview(value) {
  const json = JSON.stringify(value);
  return { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    preview: json.slice(0, 240), truncated: json.length > 240 };
}

function validate(args, allowEffects) {
  safe(args);
  const keys = (obj, names) => {
    if (Object.keys(obj).some((key) => !names.includes(key))) throw Error('unknown field in flow plan');
  };
  keys(args, ['action', 'vars', 'steps', 'allowEffects', 'stopOnError', 'outputs', 'verbose', 'waitMs']);
  if (bytes(args) > MAX_BYTES) throw Error('flow input exceeds 256 KB');
  if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 32) throw Error('steps must contain 1..32 entries');
  if (args.vars !== undefined && !object(args.vars)) throw Error('vars must be an object');
  if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') throw Error('stopOnError must be boolean');
  const effects = args.allowEffects ?? [];
  if (!Array.isArray(effects) || effects.some((v) => !EFFECT.has(v))) throw Error('invalid allowEffects');
  const seen = new Set();
  const refs = (value) => {
    if (Array.isArray(value)) return value.forEach(refs);
    if (!object(value)) return;
    if (own(value, '$literal')) {
      if (Object.keys(value).length !== 1) throw Error('$literal must be the only key');
      return;
    }
    if (own(value, '$ref')) {
      if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string' || !/^(vars|steps)(\.[A-Za-z0-9_-]+)+$/.test(value.$ref)) throw Error('invalid $ref');
      const [root, id, ...parts] = value.$ref.split('.');
      if ([id, ...parts].some((p) => BAD.has(p))) throw Error('forbidden ref key');
      if (root === 'steps' && !seen.has(id)) throw Error(`forward or unknown step ref: ${id}`);
      if (root === 'vars') reference(value.$ref, { vars: args.vars ?? {} });
      return;
    }
    Object.values(value).forEach(refs);
  };
  const checkCondition = (value) => {
    if (!object(value) || !['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte'].includes(value.op) || !own(value, 'left') || !own(value, 'right')) throw Error('invalid condition');
    keys(value, ['left', 'op', 'right']);
  };
  for (const step of args.steps) {
    if (!object(step) || typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(step.id) || BAD.has(step.id) || seen.has(step.id)) throw Error('step IDs must be unique safe names');
    keys(step, ['id', 'tool', 'args', 'set', 'assert', 'awaitBatch', 'when', 'parseJson']);
    if (['tool', 'set', 'assert', 'awaitBatch'].filter((key) => own(step, key)).length !== 1) throw Error(`${step.id}: choose exactly one of tool/set/assert/awaitBatch`);
    if (!own(step, 'tool') && (own(step, 'args') || own(step, 'parseJson'))) throw Error('args/parseJson require a tool step');
    if (step.when !== undefined) checkCondition(step.when);
    if (own(step, 'assert')) checkCondition(step.assert);
    if (own(step, 'awaitBatch')) {
      const wait = step.awaitBatch;
      if (!object(wait) || !own(wait, 'id')) throw Error('awaitBatch requires an id');
      keys(wait, ['id', 'timeoutMs']);
      if (!(typeof wait.id === 'string' && /^job-[a-z0-9-]+$/.test(wait.id) && wait.id.length <= 200)
        && !(object(wait.id) && own(wait.id, '$ref'))) throw Error('awaitBatch.id must be a batch job ID or reference');
      if (wait.timeoutMs !== undefined && (!Number.isInteger(wait.timeoutMs) || wait.timeoutMs < 1 || wait.timeoutMs > 600000)) throw Error('awaitBatch.timeoutMs must be 1..600000');
    }
    if (own(step, 'tool')) {
      if (!READ.has(step.tool) && !EFFECT.has(step.tool)) throw Error(`tool not composable: ${step.tool}`);
      if (EFFECT.has(step.tool) && (!allowEffects || !effects.includes(step.tool))) throw Error(`${step.tool} needs server OMEGA_FLOW_ALLOW_EFFECTS=1 and explicit allowEffects`);
      if (step.args !== undefined && !object(step.args)) throw Error('tool args must be an object');
      if (step.parseJson !== undefined && typeof step.parseJson !== 'boolean') throw Error('parseJson must be boolean');
    }
    refs(step);
    seen.add(step.id);
  }
  if (args.outputs !== undefined) refs(args.outputs);
}

export function createFlowRuntime(dispatch, { allowEffects = false, maxJobs = 16, ttlMs = 1_800_000 } = {}) {
  const jobs = new Map();
  const snapshot = (job, verbose) => {
    const result = { id: job.id, state: job.state, done: job.done, total: job.total,
      cancelRequested: job.cancelRequested, results: job.results,
      handles: job.handles, ...(job.active ? { active: job.active } : {}),
      ...(job.failure ? { failure: job.failure } : {}),
      ...(job.outputs !== undefined ? { outputs: job.outputs } : {}),
      ...(job.error ? { error: job.error } : {}) };
    if (!verbose) result.results = job.results.map(({ text, data, ...r }) => ({ ...r, ...(text ? { preview: text.slice(0, 240) } : {}) }));
    const data = structuredClone(result);
    return { isError: ['failed', 'cancelled'].includes(job.state), text: JSON.stringify(data), data };
  };
  const remember = (job, step, key, value) => {
    if (typeof value === 'string' && value.length <= 200)
      job.handles[step] = { ...job.handles[step], [key]: value };
  };
  const finish = (job) => { job.finished = Date.now(); job.resolve(); };
  async function run(job, args) {
    const context = { vars: structuredClone(args.vars ?? {}), steps: {} };
    let retained = bytes(context), failed = false;
    try {
      for (const step of args.steps) {
        if (job.cancelRequested || (failed && args.stopOnError !== false)) {
          const row = { id: step.id, status: 'skipped', reason: job.cancelRequested ? 'cancelled' : 'halted' };
          job.results.push(row); context.steps[step.id] = row;
          continue;
        }
        let row, phase = 'resolve';
        const tool = own(step, 'awaitBatch') ? 'omega_batch_status' : step.tool;
        job.active = { id: step.id, ...(tool ? { tool } : {}) };
        try {
          if (step.when && !condition(step.when, context)) row = { id: step.id, status: 'skipped', reason: 'condition' };
          else if (own(step, 'set')) row = { id: step.id, status: 'passed', data: resolve(step.set, context) };
          else if (own(step, 'assert')) {
            condition(step.assert, context, true);
            row = { id: step.id, status: 'passed', data: true };
          } else {
            const input = resolve(step.awaitBatch ?? step.args ?? {}, context);
            if (!object(input)) throw Error('resolved args must be an object');
            phase = 'tool_exception';
            let value;
            if (own(step, 'awaitBatch')) {
              remember(job, step.id, 'jobId', input.id);
              job.active.jobId = input.id;
              value = await awaitBatch(dispatch, input, {
                cancelled: () => job.cancelRequested,
                progress: (info) => { job.active = { id: step.id, tool, ...info }; },
              });
            } else value = await dispatch(tool, input);
            phase = 'invalid_tool_result';
            if (!value || typeof value.text !== 'string' || typeof value.isError !== 'boolean') throw Error('invalid tool result');
            row = { id: step.id, tool, status: value.isError ? 'failed' : 'passed', isError: value.isError, text: value.text };
            if (value.isError) { row.code = 'tool_error'; row.error = value.text.slice(0, 512); }
            if (tool === 'omega_batch') remember(job, step.id, 'jobId', value.data?.jobId);
            if (tool === 'omega_edit') remember(job, step.id, 'batchId', value.data?.batchId);
            phase = 'result_limit';
            if (bytes(value) + retained > MAX_BYTES) throw Error('flow result storage exceeds 256 KB; underlying action may have completed');
            phase = 'invalid_tool_result';
            if (value.data !== undefined) { safe(value.data); row.data = structuredClone(value.data); }
            if (step.parseJson) { phase = 'parse_json'; row.data = JSON.parse(value.text); safe(row.data); }
          }
          phase = 'result_limit';
          if (retained + bytes(row) > MAX_BYTES) throw Error('flow result storage exceeds 256 KB; underlying action may have completed');
        } catch (error) {
          row = { id: step.id, ...(tool ? { tool } : {}),
            status: error.code === 'cancelled' ? 'skipped' : 'failed',
            ...(error.code === 'cancelled' ? { reason: 'cancelled' } : {}),
            code: error.code || phase, error: String(error.message).slice(0, 512),
            ...(error.details ? { details: error.details } : {}),
            ...(row?.text ? { preview: row.text.slice(0, 240) } : {}) };
        }
        delete job.active;
        retained += bytes(row);
        job.results.push(row); context.steps[step.id] = row;
        if (row.status !== 'skipped') job.done++;
        if (row.status === 'failed') {
          failed = true;
          job.failure ??= { stepId: step.id, code: row.code, error: row.error };
        }
      }
      job.state = job.cancelRequested ? 'cancelled' : failed ? 'failed' : 'success';
      if (args.outputs !== undefined && job.state === 'success') {
        job.outputs = resolve(args.outputs, context);
        if (bytes(job.outputs) > MAX_BYTES) { delete job.outputs; throw Error('outputs exceed 256 KB'); }
      }
    } catch (error) { job.state = 'failed'; job.error = String(error.message).slice(0, 512); job.failure ??= { code: 'outputs', error: job.error }; }
    finally { delete job.active; finish(job); }
  }
  return async function omegaFlow(args = {}) {
    try {
      if (!object(args)) throw Error('flow arguments must be an object');
      if (args.verbose !== undefined && typeof args.verbose !== 'boolean') throw Error('verbose must be boolean');
      for (const [id, job] of jobs) if (job.finished && Date.now() - job.finished > ttlMs) jobs.delete(id);
      const action = args.action ?? 'start';
      if (!['start', 'status', 'cancel'].includes(action)) throw Error('action must be start/status/cancel');
      if (args.waitMs !== undefined && (!Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 50000)) throw Error('waitMs must be 0..50000');
      let job;
      if (action === 'start') {
        validate(args, allowEffects);
        if (jobs.size >= maxJobs) throw Error('flow capacity reached; completed jobs expire after 30 minutes');
        job = { id: `flow-${randomUUID()}`, state: 'running', total: args.steps.length, done: 0, results: [], handles: {}, cancelRequested: false };
        job.promise = new Promise((resolve) => { job.resolve = resolve; });
        jobs.set(job.id, job);
        // Defer: even a fully synchronous plan returns a real tracked job.
        const plan = structuredClone(args);
        setImmediate(() => void run(job, plan));
      } else {
        if (Object.keys(args).some((key) => !['action', 'id', 'waitMs', 'verbose'].includes(key))) throw Error('unknown field in flow control request');
        job = jobs.get(args.id);
        if (!job) throw Error('unknown or expired flow; running flows do not survive MCP restart');
        if (action === 'cancel' && job.state === 'running') job.cancelRequested = true;
      }
      const wait = args.waitMs ?? (action === 'cancel' ? 0 : 20000);
      if (job.state === 'running' && wait) {
        let timer;
        try { await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(resolve, wait); })]); }
        finally { clearTimeout(timer); }
      }
      return snapshot(job, args.verbose === true);
    } catch (error) {
      const data = { state: 'rejected', code: 'invalid_request', error: String(error.message).slice(0, 512) };
      return { isError: true, text: JSON.stringify(data), data };
    }
  };
}

const conditionSchema = { type: 'object', required: ['left', 'op', 'right'], additionalProperties: false,
  properties: { left: {}, op: { enum: ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte'] }, right: {} } };
export const FLOW_TOOL = {
  name: 'omega_flow',
  description: 'Bounded JSON micro-runtime composing omega tools. Actions start/status/cancel; 1..32 sequential tool/set/assert/awaitBatch steps. Typed refs {"$ref":"vars.x"} or {"$ref":"steps.id.data"}; no interpolation/eval/action retries. when uses {left,op,right}. awaitBatch:{id,timeoutMs?} observes an existing batch until success, default120000/max600000ms; never relaunches it. Defaults to read-only; effect tools require OMEGA_FLOW_ALLOW_EFFECTS=1 AND request allowEffects. MCP checks only omega_flow permission, not nested tool permissions; original guards still apply. Launch alone is NOT success. waitMs max50000 controls response waiting, not execution deadline. Results expose handles, active step and failure codes even without verbose. Memory-only, retained30min, max16. Cancel stops future steps/status polls, not current tools or launched batches. No automatic rollback. outputs resolve only on success; verbose returns full retained step results.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { enum: ['start', 'status', 'cancel'] }, id: { type: 'string' },
    vars: { type: 'object', additionalProperties: true },
    steps: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string' }, tool: { enum: [...READ, ...EFFECT] }, args: { type: 'object', additionalProperties: true },
        set: {}, assert: conditionSchema, when: conditionSchema, parseJson: { type: 'boolean' },
        awaitBatch: { type: 'object', required: ['id'], additionalProperties: false, properties: {
          id: { anyOf: [{ type: 'string' }, { type: 'object', required: ['$ref'], additionalProperties: false, properties: { $ref: { type: 'string' } } }] },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        } } } } },
    allowEffects: { type: 'array', items: { enum: [...EFFECT] }, description: 'Explicit effect capability list; server must also opt in. Not a replacement for host approval.' },
    stopOnError: { type: 'boolean' }, outputs: {}, verbose: { type: 'boolean' },
    waitMs: { type: 'integer', minimum: 0, maximum: 50000 },
  } },
};
