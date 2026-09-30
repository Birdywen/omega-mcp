import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitBatch } from './omega-flow-wait.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const hooks = { cancelled: () => false, progress: () => {} };
const reply = (state, isError = false) => ({ isError, text: JSON.stringify({ id: 'job-test', state }) });

test('await observes one existing batch until success, never relaunches', async () => {
  const calls = [], progress = [];
  const result = await awaitBatch(async (name, args) => {
    calls.push({ name, args }); return reply(calls.length === 1 ? 'running' : 'success');
  }, { id: 'job-test', timeoutMs: 3000 }, { ...hooks, progress: (p) => progress.push(p) });
  assert.equal(result.data.state, 'success'); assert.equal(calls.length, 2);
  assert(calls.every((c) => c.name === 'omega_batch_status' && c.args.id === 'job-test' && c.args.waitMs > 0));
  assert.deepEqual(progress.map((p) => p.state), ['running', 'success']);
});

test('failed, partial and cancelled never become success regardless of isError', async () => {
  for (const state of ['failed', 'partial', 'cancelled']) {
    await assert.rejects(awaitBatch(async () => reply(state), { id: 'job-test' }, hooks), { code: 'batch_failed' });
  }
});

test('deadline is bounded and immediate running replies do not busy-poll', async () => {
  let calls = 0;
  await assert.rejects(awaitBatch(async () => { calls++; return reply('running'); },
    { id: 'job-test', timeoutMs: 20 }, hooks), { code: 'batch_timeout' });
  assert.equal(calls, 1);
});

test('cancellation stops polling without cancelling the batch', async () => {
  let cancel = false, calls = 0;
  await assert.rejects(awaitBatch(async (name) => {
    assert.equal(name, 'omega_batch_status'); calls++; cancel = true; return reply('running');
  }, { id: 'job-test' }, { ...hooks, cancelled: () => cancel }), { code: 'cancelled' });
  assert.equal(calls, 1);
});

test('unknown IDs, malformed status and invalid timeout are explicit failures', async () => {
  await assert.rejects(awaitBatch(async () => ({ text: 'no such batch', isError: true }), { id: 'job-test' }, hooks), { code: 'tool_error' });
  await assert.rejects(awaitBatch(async () => ({ text: '{}', isError: false }), { id: 'job-test' }, hooks), { code: 'invalid_batch_status' });
  await assert.rejects(awaitBatch(async () => reply('success'), { id: 'job-test', timeoutMs: 0 }, hooks), { code: 'invalid_timeout' });
  await assert.rejects(awaitBatch(async () => reply('success'), { id: '../bad' }, hooks), { code: 'invalid_batch_id' });
});

test('a success observed after the deadline is timeout, with observed state retained', async () => {
  await assert.rejects(awaitBatch(async () => { await sleep(15); return reply('success'); },
    { id: 'job-test', timeoutMs: 1 }, hooks), (error) => {
    assert.equal(error.code, 'batch_timeout'); assert.equal(error.details.state, 'success');
    assert.equal(error.details.jobId, 'job-test'); return true;
  });
});

test('flow cancellation takes precedence over a concurrent successful batch reply', async () => {
  let cancel = false;
  await assert.rejects(awaitBatch(async () => { cancel = true; return reply('success'); },
    { id: 'job-test' }, { ...hooks, cancelled: () => cancel }), { code: 'cancelled' });
});
