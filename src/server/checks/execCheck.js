// Runs a command on a box over the ControlMaster Tmuxifier already holds open.
// This is why most node-workload coverage costs nothing new: no agent to
// install, no API to expose, no credentials to store. The command text is
// operator-authored and travels the same validated argv path as every probe.
const MAX_DETAIL = 300;

const trim = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, MAX_DETAIL);

export async function runExecCheck(check, { boxActions, store, now = () => Date.now() } = {}) {
  const started = now();
  const fail = (detail) => ({ ok: false, detail, latencyMs: now() - started });
  // The whole body is guarded, not just the execCommand call. This executor
  // reaches two injected collaborators before it reaches the network, and each
  // can throw for reasons that have nothing to do with the box being probed:
  // the box lookup dereferences check.target, and listBoxes() does real disk
  // I/O that rejects on an unreadable boxes.json. Either escaping would abort
  // the runner's due cycle and take every check scheduled alongside with it.
  try {
    const boxId = check?.target?.boxId;
    const box = (await store.listBoxes()).find((b) => b.id === boxId);
    if (!box) return fail(`box ${boxId} no longer exists`);
    let res;
    try {
      res = await boxActions.execCommand(box, check.target.command, { timeoutMs: check.timeoutMs || 15000 });
    } catch (e) {
      return fail(trim(e?.message || 'command failed to run'));
    }
    if (res.code !== 0) return fail(`exit ${res.code}: ${trim(res.stderr || res.stdout) || 'no output'}`);
    const marker = check.assert?.stdoutIncludes;
    if (marker && !String(res.stdout || '').includes(marker)) {
      return fail(`stdout did not contain "${marker}": ${trim(res.stdout) || 'no output'}`);
    }
    return { ok: true, detail: trim(res.stdout) || 'exit 0', latencyMs: now() - started };
  } catch (e) {
    return fail(trim(e?.message || 'check could not run'));
  }
}
