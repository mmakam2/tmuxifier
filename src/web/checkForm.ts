export interface CheckField { name: string; label: string; placeholder?: string; numeric?: boolean }

// The field list per type lives here rather than in the DOM code so it can be
// unit-tested; the server remains the validation authority regardless.
const FIELDS: Record<string, CheckField[]> = {
  http: [{ name: 'url', label: 'URL', placeholder: 'https://invoices.example.com/health' }],
  tcp: [
    { name: 'host', label: 'Host', placeholder: '192.168.1.10' },
    { name: 'port', label: 'Port', placeholder: '443', numeric: true },
  ],
  json: [
    { name: 'url', label: 'URL', placeholder: 'https://node.example.com/api/sno' },
    { name: 'path', label: 'JSON path', placeholder: 'quicStatus' },
  ],
  exec: [
    { name: 'boxId', label: 'Box', placeholder: 'pick a box' },
    { name: 'command', label: 'Command', placeholder: 'systemctl is-active myservice' },
  ],
  heartbeat: [
    { name: 'windowSec', label: 'Expect a check-in every (seconds)', placeholder: '86400', numeric: true },
    { name: 'graceSec', label: 'Grace period (seconds)', placeholder: '3600', numeric: true },
  ],
};

// Which types the form actually offers, which is deliberately narrower than the
// server's CHECK_TYPES (checkTypes.js) and narrower than FIELDS above.
//
// Validation accepts all five types already, but only the types with an executor
// wired into the dispatcher can produce a real result: for any other type
// createCheckDispatcher returns { ok: false, detail: 'no executor for type "x"' }.
// That is a failing check, which folds into a firing alert, which can notify —
// so offering a type before its executor lands would let an operator create a
// check whose only possible outcome is a false alarm about our own missing code.
//
// Each slice adds its types here as the executor lands: Slice B appends 'tcp',
// 'json', and 'exec'; Slice C appends 'heartbeat'.
export const IMPLEMENTED_TYPES = ['http', 'tcp', 'json', 'exec'];

export function checkFieldsFor(type: string): CheckField[] {
  return FIELDS[type] ?? [];
}

export function checkFormPayload(values: Record<string, unknown>): Record<string, unknown> {
  const type = String(values.type || '');
  const target: Record<string, unknown> = {};
  for (const f of checkFieldsFor(type)) {
    const raw = values[f.name];
    if (raw === undefined || raw === '') continue;
    target[f.name] = f.numeric ? Number(raw) : String(raw);
  }
  const payload: Record<string, unknown> = {
    label: String(values.label || '').trim(),
    type,
    target,
  };
  if (values.severity) payload.severity = String(values.severity);
  if (values.intervalSec !== undefined && values.intervalSec !== '') payload.intervalSec = Number(values.intervalSec);
  if (values.timeoutMs !== undefined && values.timeoutMs !== '') payload.timeoutMs = Number(values.timeoutMs);
  if (values.failuresBeforeNotify !== undefined && values.failuresBeforeNotify !== '') {
    payload.failuresBeforeNotify = Number(values.failuresBeforeNotify);
  }
  if (values.enabled !== undefined) payload.enabled = !!values.enabled;
  // A blank secret means "leave the stored one alone" — omitting the key is what
  // lets an edit form avoid round-tripping a credential through the browser.
  const secret = typeof values.secret === 'string' ? values.secret.trim() : '';
  if (secret) payload.secret = secret;
  return payload;
}
