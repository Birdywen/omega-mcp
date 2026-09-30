// Bounded observation of an existing batch. Never launches or cancels work.
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

export function flowError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

export async function awaitBatch(dispatch, { id, timeoutMs = 120000 }, { cancelled, progress }) {
  if (typeof id !== 'string' || !/^job-[a-z0-9-]+$/.test(id) || id.length > 200)
    throw flowError('invalid_batch_id', 'awaitBatch.id must be a batch job ID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw flowError('invalid_timeout', 'awaitBatch.timeoutMs must be 1..600000');
  const deadline = performance.now() + timeoutMs;
  let polls = 0;
  while (true) {
    if (cancelled()) throw flowError('cancelled', 'batch wait cancelled; underlying batch continues', { jobId: id, polls });
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw flowError('batch_timeout', 'batch wait timed out; query the original job ID', { jobId: id, polls });
    const started = performance.now();
    const result = await dispatch('omega_batch_status', { id, format: 'json', waitMs: Math.max(1, Math.min(5000, Math.ceil(remaining))) });
    polls++;
    if (cancelled()) throw flowError('cancelled', 'batch wait cancelled; underlying batch continues', { jobId: id, polls });
    if (!result || typeof result.text !== 'string' || typeof result.isError !== 'boolean')
      throw flowError('invalid_tool_result', 'invalid batch status response', { jobId: id, polls });
    // Match the flow storage budget before parsing a potentially large response.
    if (Buffer.byteLength(result.text) > 256000)
      throw flowError('result_limit', 'batch status exceeds 256 KB; query the original job ID', { jobId: id, polls });
    let data;
    try { data = JSON.parse(result.text); }
    catch { throw flowError(result.isError ? 'tool_error' : 'parse_json', 'batch status did not return JSON', { jobId: id, polls, preview: result.text.slice(0, 240) }); }
    if (!data || data.id !== id || !['running', 'success', 'failed', 'partial', 'cancelled'].includes(data.state))
      throw flowError('invalid_batch_status', 'batch status ID or state is invalid', { jobId: id, polls });
    progress({ jobId: id, polls, state: data.state });
    if (performance.now() >= deadline)
      throw flowError('batch_timeout', 'batch wait timed out; query the original job ID', { jobId: id, polls, state: data.state });
    if (data.state !== 'running') {
      if (result.isError || data.state !== 'success')
        throw flowError('batch_failed', `batch ended ${data.state}`, { jobId: id, polls, state: data.state });
      return { ...result, data };
    }
    if (result.isError) throw flowError('tool_error', 'batch status reported an error while running', { jobId: id, polls });
    // A status implementation may return running immediately. Never busy-poll.
    const nextPoll = Math.min(started + 1000, deadline);
    while (!cancelled() && performance.now() < nextPoll)
      await sleep(Math.max(1, Math.ceil(nextPoll - performance.now())));
  }
}
