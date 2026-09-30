import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlowRuntime } from './omega-flow.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { omegaRead, omegaEdit, omegaUndo, omegaBatch, omegaBatchStatus } from './tools-ext.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ref = (path) => ({ $ref: path });
const check = (left, right) => ({ left, op: 'eq', right });
test('typed references, conditions, JSON results and outputs', async () => {
  const calls = [];
  const flow = createFlowRuntime(async (name, args) => { calls.push(args); return { isError: false, text: JSON.stringify(args) }; });
  const r = await flow({ vars: { number: 3, obj: { ok: true } }, steps: [
    { id: 'a', tool: 'omega_read', args: { n: ref('vars.number'), obj: ref('vars.obj') }, parseJson: true },
    { id: 'b', assert: check(ref('steps.a.data.n'), 3) },
    { id: 'c', set: 'never', when: check(ref('vars.number'), 4) },
  ], outputs: ref('steps.a.data') });
  assert.equal(r.data.state, 'success'); assert.deepEqual(r.data.outputs, { n: 3, obj: { ok: true } });
  assert.equal(r.data.results[2].status, 'skipped'); assert.equal(calls.length, 1);
});
test('preflight rejects effects, recursion, bad refs and duplicate IDs before any call', async () => {
  let calls = 0;
  const flow = createFlowRuntime(async () => { calls++; return { isError: false, text: 'ok' }; });
  for (const bad of [
    { id: 'bad', tool: 'omega_edit', args: {} }, { id: 'bad', tool: 'omega_flow' },
    { id: 'bad', set: ref('steps.future.data') }, { id: 'first', set: 1 },
    { id: 'bad', set: ref('vars.constructor') },
  ]) assert.equal((await flow({ steps: [{ id: 'first', tool: 'omega_read' }, bad] })).isError, true);
  assert.equal(calls, 0);
});
test('effects require both flags and reuse dispatch', async () => {
  let calls = 0;
  const flow = createFlowRuntime(async () => { calls++; return { isError: false, text: 'edited', data: { batchId: 'edit-real' } }; }, { allowEffects: true });
  const step = { id: 'edit', tool: 'omega_edit', args: { dryRun: true } };
  assert.equal((await flow({ steps: [step] })).isError, true);
  const result = await flow({ steps: [step], allowEffects: ['omega_edit'], outputs: ref('steps.edit.data.batchId') });
  assert.equal(result.data.outputs, 'edit-real'); assert.equal(calls, 1);
});
test('failed assertions halt; continue records overall failure', async () => {
  const flow = createFlowRuntime(async () => ({ isError: true, text: 'real tool failure' }));
  const steps = [{ id: 'bad', assert: check(1, 2) }, { id: 'after', set: 3 }];
  const a = await flow({ steps }); assert.equal(a.data.results[1].reason, 'halted');
  const b = await flow({ steps, stopOnError: false }); assert.equal(b.data.results[1].status, 'passed'); assert.equal(b.isError, true);
  assert.equal((await flow({ steps: [{ id: 'tool', tool: 'omega_read' }] })).data.state, 'failed');
});
test('literal escapes refs; copies isolate variable mutation', async () => {
  const flow = createFlowRuntime(async (_name, args) => { args.obj.x = 99; return { isError: false, text: '{}' }; });
  const r = await flow({ vars: { obj: { x: 1 } }, steps: [
    { id: 'a', tool: 'omega_read', args: { obj: ref('vars.obj') } },
    { id: 'b', set: { $literal: { $ref: 'not a reference' } } },
  ], outputs: { x: ref('vars.obj.x'), literal: ref('steps.b.data') } });
  assert.deepEqual(r.data.outputs, { x: 1, literal: { $ref: 'not a reference' } });
});
test('running handle, bounded wait and cooperative cancellation', async () => {
  let release, entered;
  const started = new Promise((r) => { entered = r; });
  const block = new Promise((r) => { release = r; });
  const flow = createFlowRuntime(async () => { entered(); await block; return { isError: false, text: 'finished current call' }; });
  const r = await flow({ waitMs: 0, steps: [{ id: 'slow', tool: 'omega_read' }, { id: 'later', set: 2 }] });
  assert.equal(r.data.state, 'running'); await started;
  const c = await flow({ action: 'cancel', id: r.data.id }); assert.equal(c.data.cancelRequested, true);
  release(); const done = await flow({ action: 'status', id: r.data.id, waitMs: 1000 });
  assert.equal(done.data.state, 'cancelled'); assert.equal(done.isError, true); assert.equal(done.data.results[1].reason, 'cancelled');
});
test('storage limits, malformed JSON and prototype input fail closed', async () => {
  const flow = createFlowRuntime(async () => ({ isError: false, text: 'x'.repeat(260000) }));
  assert.equal((await flow({ steps: [{ id: 'a', tool: 'omega_read' }] })).data.state, 'failed');
  assert.equal((await flow({ steps: [{ id: 'a', tool: 'omega_read', parseJson: true }] })).data.state, 'failed');
  assert.equal((await flow(JSON.parse('{"vars":{"__proto__":{}},"steps":[{"id":"a","set":1}]}'))).isError, true);
});

test('reference fanout is bounded before materializing oversized output', async () => {
  const flow = createFlowRuntime(async () => ({ isError: false, text: '' }));
  const r = await flow({ vars: { large: 'x'.repeat(100000) }, steps: [
    { id: 'a', set: [ref('vars.large'), ref('vars.large'), ref('vars.large')] },
  ] });
  assert.equal(r.data.state, 'failed');
  assert.match(r.data.results[0].error, /resolved value exceeds/);
});

test('real read/edit/undo compose with structured undo ID, preserving existing semantics', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omega-flow-edit-'));
  const file = path.join(dir, 'sample.txt');
  writeFileSync(file, 'before\n');
  const tools = { omega_read: omegaRead, omega_edit: omegaEdit, omega_undo: omegaUndo };
  const flow = createFlowRuntime((name, args) => tools[name](args), { allowEffects: true });
  try {
    const result = await flow({ vars: { file }, allowEffects: ['omega_edit', 'omega_undo'], steps: [
      { id: 'edit', tool: 'omega_edit', args: { edits: [{ path: ref('vars.file'), oldString: 'before', newString: 'after' }] } },
      { id: 'read', tool: 'omega_read', args: { path: ref('vars.file') } },
      { id: 'check', assert: { left: ref('steps.read.text'), op: 'contains', right: 'after' } },
      { id: 'undo', tool: 'omega_undo', args: { batchId: ref('steps.edit.data.batchId') } },
    ] });
    assert.equal(result.data.state, 'success'); assert.equal(readFileSync(file, 'utf8'), 'before\n');
    const dry = await flow({ allowEffects: ['omega_edit'], steps: [
      { id: 'dry', tool: 'omega_edit', args: { dryRun: true, edits: [{ path: file, oldString: 'before', newString: 'other' }] } },
    ], outputs: ref('steps.dry.data') });
    assert.equal(dry.data.outputs.batchId, null); assert.equal(readFileSync(file, 'utf8'), 'before\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real batch guard and structured job ID compose; launch alone is not a completion assertion', async () => {
  let runs = 0;
  const flow = createFlowRuntime((name, args) => name === 'omega_batch'
    ? omegaBatch(args, async () => { runs++; return { isError: false, text: 'TOKEN' }; })
    : omegaBatchStatus(args), { allowEffects: true });
  const result = await flow({ allowEffects: ['omega_batch'], steps: [
    { id: 'start', tool: 'omega_batch', args: { steps: [{ command_line: 'true', expect: { contains: ['TOKEN'] } }] } },
    { id: 'wait', tool: 'omega_batch_status', args: { id: ref('steps.start.data.jobId'), waitMs: 1000, format: 'json' }, parseJson: true },
    { id: 'accept', assert: check(ref('steps.wait.data.state'), 'success') },
  ] });
  assert.equal(result.data.state, 'success'); assert.equal(runs, 1);
  const blocked = await flow({ allowEffects: ['omega_batch'], steps: [
    { id: 'bad', tool: 'omega_batch', args: { steps: [{ command_line: 'echo bad > /etc/omega-flow-test' }] } },
  ] });
  assert.equal(blocked.data.state, 'failed'); assert.equal(runs, 1);
});

test('MCP wire advertises flow alongside old tools, with read-only default', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omega-flow-wire-'));
  const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    env: { ...process.env, OMEGA_FLOW_ALLOW_EFFECTS: '0', OMEGA_MCP_LOG: path.join(dir, 'log') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(Error('MCP response timed out')), 5000);
    pending.set(key, (value) => { clearTimeout(timer); pending.delete(key); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  try {
    const list = await request('tools/list');
    const names = list.result.tools.map((t) => t.name);
    for (const name of ['omega_flow', 'omega_read', 'omega_edit', 'omega_batch']) assert(names.includes(name));
    const file = path.join(dir, 'fixture.txt'); writeFileSync(file, 'WIRE_TOKEN');
    const r = await request('tools/call', { name: 'omega_flow', arguments: { vars: { file }, steps: [
      { id: 'read', tool: 'omega_read', args: { path: ref('vars.file') } },
      { id: 'assert', assert: { left: ref('steps.read.text'), op: 'contains', right: 'WIRE_TOKEN' } },
    ], outputs: ref('steps.read.text') } });
    assert.equal(r.result.isError, false); assert.equal(JSON.parse(r.result.content[0].text).state, 'success');
    const blocked = await request('tools/call', { name: 'omega_flow', arguments: {
      allowEffects: ['omega_edit'], steps: [{ id: 'edit', tool: 'omega_edit', args: {} }],
    } });
    assert.equal(blocked.result.isError, true);
    const old = await request('tools/call', { name: 'omega_read', arguments: { path: file } });
    assert.equal(old.result.content[0].text, JSON.parse(r.result.content[0].text).outputs);
  } finally { lines.close(); child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
