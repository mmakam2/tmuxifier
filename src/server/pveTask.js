// Shared PVE task poller for the provision and lifecycle job managers
// (previously duplicated line-for-line in both). Tails the task log through
// onLog, and tolerates up to maxPollFailures consecutive taskStatus errors —
// one network blip or pveproxy restart during a minutes-long create/start
// poll must not fail the whole job and orphan the container. Resolves when
// the task stops with exitstatus OK; throws on task failure, persistent
// status errors, or the deadline.
export async function pollPveTask(client, node, upid, { onLog, timeoutMs, pollMs, sleep, maxPollFailures }) {
  const deadline = Date.now() + timeoutMs;
  let logStart = 0;
  let failures = 0;
  for (;;) {
    const lines = await client.taskLog(node, upid, logStart).catch(() => []);
    if (Array.isArray(lines) && lines.length) {
      logStart += lines.length;
      onLog(`${lines.map((line) => line.t).join('\n')}\n`);
    }
    let status = null;
    try {
      status = await client.taskStatus(node, upid);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= maxPollFailures) throw error;
    }
    if (status?.status === 'stopped') {
      if (status.exitstatus && status.exitstatus !== 'OK') throw new Error(`task failed: ${status.exitstatus}`);
      return;
    }
    if (Date.now() > deadline) throw new Error('task timed out');
    await sleep(pollMs);
  }
}
