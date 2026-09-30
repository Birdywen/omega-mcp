import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlowRuntime } from './omega-flow.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ref = (path) => ({ $ref: path });
const launch = { id: 'launch', tool: 'omega_batch', args: { steps: [] } };
const wait = { id: 'wait', awaitBatch: { id: ref('steps.launch.data.jobId'), timeoutMs: 3000 } };
const status = (state) => ({ isError: false, text: JSON.stringify({ id: 'job-test', state }) });

test('flow await keeps original handles, waits to success and launches only once', async () => {
  let launches = 0, polls = 0;
  const flow = createFlowRuntime(async (name) => {
    if (name === 'omega_batch') { launches++; return { isError: false, text: 'started', data: { jobId: 'job-test' } }; }
    assert.equal(name, 'omega_batch_status'); return status(++polls === 1 ? 'running' : 'success');
  }, { allowEffects: true });
  const r = await flow({ allowEffects: ['omega_batch'], steps: [launch, wait], outputs: ref('steps.wait.data.state') });
  assert.equal(r.data.state, 'success'); assert.equal(r.data.outputs, 'success');
  assert.equal(launches, 1); assert.equal(polls, 2);
  assert.deepEqual(r.data.handles, { launch: { jobId: 'job-test' }, wait: { jobId: 'job-test' } });
});

test('timeout retains handle without verbose, halts later steps and never relaunches', async () => {
  let launches = 0, polls = 0;
  const flow = createFlowRuntime(async (name) => {
    if (name === 'omega_batch') { launches++; return { isError: false, text: 'started', data: { jobId: 'job-test' } }; }
    polls++; return status('running');
  }, { allowEffects: true });
  const r = await flow({ allowEffects: ['omega_batch'], steps: [launch,
    { id: 'wait', awaitBatch: { id: ref('steps.launch.data.jobId'), timeoutMs: 20 } }, { id: 'after', set: 1 }] });
  assert.equal(r.data.state, 'failed'); assert.equal(r.data.failure.code, 'batch_timeout');
  assert.equal(r.data.failure.stepId, 'wait'); assert.equal(r.data.handles.launch.jobId, 'job-test');
  assert.equal(r.data.results[2].reason, 'halted'); assert.equal(launches, 1); assert.equal(polls, 1);
});

test('cancel while waiting exposes active handle and stops future polling, not the batch', async () => {
  let release, entered, calls = 0;
  const gate = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  const flow = createFlowRuntime(async (name) => {
    assert.equal(name, 'omega_batch_status'); calls++; entered(); await gate; return status('running');
  });
  const r = await flow({ waitMs: 0, steps: [{ id: 'wait', awaitBatch: { id: 'job-test' } }, { id: 'later', set: 1 }] });
  await started;
  const running = await flow({ action: 'status', id: r.data.id, waitMs: 0 });
  assert.equal(running.data.active.jobId, 'job-test');
  await flow({ action: 'cancel', id: r.data.id }); release();
  const done = await flow({ action: 'status', id: r.data.id, waitMs: 1000 });
  assert.equal(done.data.state, 'cancelled'); assert.equal(done.data.results[1].reason, 'cancelled');
  assert.equal(done.data.handles.wait.jobId, 'job-test'); assert.equal(calls, 1);
});

test('assertion diagnostics distinguish operand types; parse failure retains tool evidence', async () => {
  const flow = createFlowRuntime(async () => ({ isError: false, text: 'not-json: source evidence' }));
  const r = await flow({ stopOnError: false, steps: [
    { id: 'check', assert: { left: 1, op: 'eq', right: '1' } },
    { id: 'parse', tool: 'omega_read', parseJson: true },
  ] });
  const [check, parse] = r.data.results;
  assert.equal(check.code, 'assertion_failed'); assert.equal(check.details.left.type, 'number');
  assert.equal(check.details.right.type, 'string'); assert.equal(r.data.failure.stepId, 'check');
  assert.equal(parse.code, 'parse_json'); assert.equal(parse.tool, 'omega_read');
  assert.match(parse.preview, /source evidence/);
});

test('handles survive later errors and result limits; caller cannot mutate stored snapshots', async () => {
  const flow = createFlowRuntime(async () => ({ isError: false, text: 'x'.repeat(260000), data: { batchId: 'edit-real' } }), { allowEffects: true });
  const r = await flow({ allowEffects: ['omega_edit'], steps: [{ id: 'edit', tool: 'omega_edit' }] });
  assert.equal(r.data.failure.code, 'result_limit'); assert.equal(r.data.handles.edit.batchId, 'edit-real');
  r.data.handles.edit.batchId = 'corrupted'; r.data.results[0].error = 'corrupted';
  const next = await flow({ action: 'status', id: r.data.id, verbose: true });
  assert.equal(next.data.handles.edit.batchId, 'edit-real'); assert.notEqual(next.data.results[0].error, 'corrupted');
});

test('invalid await plans are rejected before an earlier effect; control fields are strict', async () => {
  let calls = 0;
  const flow = createFlowRuntime(async () => { calls++; }, { allowEffects: true });
  for (const bad of [
    { id: 'wait', awaitBatch: { id: 'job-test', timeoutMs: 0 } },
    { id: 'wait', awaitBatch: { id: 'job-test', timeoutMs: 600001 } },
    { id: 'wait', awaitBatch: { id: 'job-test', retry: true } },
    { id: 'wait', awaitBatch: { id: ref('steps.future.data') } },
    { id: 'wait', awaitBatch: { id: 'job-test' }, tool: 'omega_read' },
    { id: 'wait', awaitBatch: { id: 'job-test' }, parseJson: true },
  ]) {
    const r = await flow({ allowEffects: ['omega_batch'], steps: [launch, bad] });
    assert.equal(r.data.state, 'rejected');
  }
  assert.equal(calls, 0);
  const r = await flow({ steps: [{ id: 'ok', set: 1 }] });
  const bad = await flow({ action: 'status', id: r.data.id, typo: true });
  assert.equal(bad.data.state, 'rejected');
});

test('real MCP wire executes batch once, awaits it, and verifies actual stdout', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omega-flow-round2-'));
  const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    env: { ...process.env, OMEGA_FLOW_ALLOW_EFFECTS: '1', OMEGA_MCP_LOG: path.join(dir, 'log') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0; const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  child.stderr.resume();
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(Error('MCP timed out')); }, 10000);
    pending.set(key, (value) => { clearTimeout(timer); pending.delete(key); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  try {
    const list = await request('tools/list');
    const schema = list.result.tools.find((t) => t.name === 'omega_flow').inputSchema;
    assert(schema.properties.steps.items.properties.awaitBatch);
    const response = await request('tools/call', { name: 'omega_flow', arguments: {
      allowEffects: ['omega_batch'], steps: [
        { id: 'launch', tool: 'omega_batch', args: { steps: [{
          label: 'stdout proof', command_line: 'python3 -c \'import time; time.sleep(0.35); print("FLOW_WIRE_OK")\'',
          cwd: dir, timeout: '5s', expect: { contains: ['FLOW_WIRE_OK'] },
        }] } },
        { id: 'wait', awaitBatch: { id: ref('steps.launch.data.jobId'), timeoutMs: 5000 } },
        { id: 'proof', assert: { left: ref('steps.wait.data.results.0.text'), op: 'contains', right: 'FLOW_WIRE_OK' } },
      ], outputs: ref('steps.wait.data.state'),
    } });
    assert.equal(response.result.isError, false, JSON.stringify(response));
    const data = JSON.parse(response.result.content[0].text);
    assert.equal(data.state, 'success'); assert.equal(data.outputs, 'success');
    assert.equal(data.handles.launch.jobId, data.handles.wait.jobId);
  } finally {
    lines.close();
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    rmSync(dir, { recursive: true, force: true });
  }
});
