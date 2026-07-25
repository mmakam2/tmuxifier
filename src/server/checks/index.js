// Type-to-executor lookup, injected rather than imported, so a test can supply a
// fake executor and the runner never grows a switch statement over check types.
export function createCheckDispatcher({ runners = {} } = {}) {
  return {
    async run(check, deps = {}) {
      const fn = runners[check.type];
      if (!fn) return { ok: false, detail: `no executor for type "${check.type}"`, latencyMs: 0 };
      return fn(check, deps);
    },
  };
}
