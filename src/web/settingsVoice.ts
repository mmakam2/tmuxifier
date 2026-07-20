import { el } from './dom';
import { voiceApi, type VoiceStatus, type VoiceJob } from './voice';
import { detectVoiceEnv } from './voiceUi';
import { createSetupJobPoller } from './setupPoller';

// Pure: the one-line summary at the top of the tab. Kept out of the DOM code so
// the wording is unit-testable.
export function voiceStatusLine(
  s: Pick<VoiceStatus, 'installed' | 'enabled' | 'model' | 'pinned'>,
): string {
  if (!s.installed) return 'whisper.cpp is not installed on this host.';
  const base = s.enabled
    ? `Voice dictation is on, using ${s.model}.`
    : 'whisper.cpp is installed, but voice dictation is disabled.';
  // Without this the picker would look broken: .env wins and is read only at
  // boot, so a selection here would silently do nothing.
  return s.pinned.model === 'env'
    ? `${base} The model is pinned by TMUXIFIER_WHISPER_MODEL in .env; remove that line to choose here.`
    : base;
}

// Pure: turn the outcome of a getUserMedia probe into something actionable.
// `err` is null on success. Ordered like evaluateVoice — the most fundamental
// blocker wins, so an unsupported browser is never told to go fix TLS.
export function micTestMessage(
  err: { name?: string; message?: string } | null,
  env: { supported: boolean; secureContext: boolean },
): string {
  if (!env.supported) return 'This browser has no microphone capture support.';
  if (!env.secureContext) {
    return 'Microphone access needs a secure context (HTTPS or localhost). Configure TLS — see docs/DEPLOY.md — or reach Tmuxifier on localhost.';
  }
  if (!err) return 'Microphone access granted. Voice dictation is ready to use.';

  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // NotAllowedError covers BOTH a user denial and a page that was loaded
      // before voice was enabled (Permissions-Policy is applied at document
      // load and cannot be changed afterwards). The browser does not let us
      // tell them apart, so name both rather than guessing and sending the
      // operator down the wrong path.
      return 'Microphone blocked. If you enabled voice just now, reload this page and try again — '
        + 'the browser fixes the microphone policy when the page loads. Otherwise access was '
        + 'denied for this site; re-allow it in your browser’s site settings.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone found. Connect a capture device and try again.';
    case 'NotReadableError':
      return 'The microphone is in use by another application and could not be opened.';
    default:
      return `Microphone test failed: ${err.message || err.name || 'unknown error'}`;
  }
}

// Pure: poll policy for the install job. Milliseconds until the next poll, or
// null to stop.
export function installPollDelay(job: VoiceJob | null): number | null {
  if (!job) return 2000;            // transient fetch failure — keep trying
  return job.status === 'running' ? 1000 : null;
}

export async function renderVoiceSection(content: HTMLElement): Promise<void> {
  content.textContent = 'Loading…';
  let status: VoiceStatus;
  try {
    status = await voiceApi.status();
  } catch (e) {
    content.textContent = `Could not load voice settings: ${(e as Error).message}`;
    return;
  }

  content.textContent = '';
  content.appendChild(el('p', { class: 'muted' }, [voiceStatusLine(status)]));

  const logBox = el('pre', { class: 'voice-log' });
  logBox.style.display = 'none';

  const refresh = () => renderVoiceSection(content);

  // --- enable toggle -------------------------------------------------------
  if (status.installed) {
    const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    toggle.checked = status.enabled;
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      const turningOn = toggle.checked;
      try {
        await voiceApi.saveSettings({ enabled: turningOn });
        // Permissions-Policy is per-document: a tab loaded while voice was off
        // was served microphone=(), and no amount of enabling changes that for
        // the page already in the browser. Say so rather than letting the mic
        // appear broken.
        if (turningOn) {
          content.appendChild(el('p', { class: 'muted' },
            ['Reload this page for the browser to grant microphone access.']));
        }
        await refresh();
      } finally {
        toggle.disabled = false;
      }
    });
    content.appendChild(el('label', {}, [toggle, ' Enable voice dictation']));

    // --- microphone permission check ---------------------------------------
    // Only offered once voice is on: while it is off the page is served
    // microphone=(), so getUserMedia would fail for a reason that has nothing
    // to do with the operator's browser permission.
    if (status.enabled) {
      const result = el('p', { class: 'muted' });
      const test = el('button', {}, ['Check microphone access']) as HTMLButtonElement;
      test.addEventListener('click', async () => {
        test.disabled = true;
        result.textContent = 'Checking…';
        const env = detectVoiceEnv(true);
        let stream: MediaStream | null = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          result.textContent = micTestMessage(null, env);
        } catch (e) {
          result.textContent = micTestMessage(e as { name?: string; message?: string }, env);
        } finally {
          // Release immediately. This probe only asks the browser for
          // permission — holding the track would leave the tab's recording
          // indicator lit with nothing listening.
          try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
          test.disabled = false;
        }
      });
      content.appendChild(test);
      content.appendChild(result);
    }
  }

  // --- install -------------------------------------------------------------
  function watch(id: string): void {
    logBox.style.display = '';
    const poller = createSetupJobPoller<VoiceJob>({
      fetchJob: () => voiceApi.job(id).catch(() => null),
      onJob: (job) => {
        if (job) {
          logBox.textContent = job.log || '(no output yet)';
          if (job.status === 'error') logBox.textContent += `\n\nFAILED: ${job.error}`;
          logBox.scrollTop = logBox.scrollHeight;
          if (job.status !== 'running') void refresh();
        }
        return installPollDelay(job);
      },
    });
    poller.start();
  }

  async function startInstall(model: string): Promise<void> {
    logBox.style.display = '';
    logBox.textContent = 'Starting…';
    try {
      const job = await voiceApi.install(model);
      watch(job.id);
    } catch (e) {
      logBox.textContent = `Install could not start: ${(e as Error).message}`;
    }
  }

  // --- model picker --------------------------------------------------------
  const pinned = status.pinned.model === 'env';
  const list = el('div', { class: 'voice-models' });
  for (const m of status.models) {
    const row = el('label', { class: 'voice-model' });
    const radio = el('input', { type: 'radio', name: 'voice-model' }) as HTMLInputElement;
    radio.checked = m.id === status.model;
    radio.disabled = pinned;
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      // Choosing a model that is not on disk is what triggers a download.
      if (m.installed) { await voiceApi.saveSettings({ model: m.id }); await refresh(); }
      else await startInstall(m.id);
    });
    row.append(radio, ` ${m.id} — ${(m.bytes / 1024 ** 2).toFixed(0)} MB`,
      m.installed ? ' (installed)' : ' (will download)');
    list.appendChild(row);
  }
  content.appendChild(list);

  if (!status.installed) {
    const btn = el('button', { class: 'primary' }, ['Install whisper.cpp']) as HTMLButtonElement;
    btn.addEventListener('click', () => { btn.disabled = true; void startInstall(status.model || 'small.en'); });
    content.appendChild(btn);
    content.appendChild(el('p', { class: 'muted' }, [
      'Takes roughly two minutes and about 1.2 GB of disk. Installs cmake if it is missing, builds whisper.cpp from a pinned release, and downloads the model. You can navigate away — it runs on the server.',
    ]));
  }

  content.appendChild(logBox);
  // A build already running when the tab opens (after a refresh, or from
  // another browser) is re-attached rather than orphaned.
  if (status.job && status.job.status === 'running') watch(status.job.id);
}
