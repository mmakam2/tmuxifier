import { pve, type LifecycleJobSummary, type ProvisionSummary } from './proxmox';
import { el } from './dom';

export type ActivityItem = {
  kind: 'provision' | 'lifecycle'; id: string; title: string; subtitle: string;
  status: string; createdAt: string;
};

export function mergeActivity(provisions: ProvisionSummary[], lifecycle: LifecycleJobSummary[]): ActivityItem[] {
  return [
    ...provisions.map((job) => ({ kind: 'provision' as const, id: job.id, title: `Provision | ${job.hostname}`, subtitle: `${job.presetName} | VMID ${job.vmid ?? '-'}`, status: job.status, createdAt: job.createdAt })),
    ...lifecycle.map((job) => ({ kind: 'lifecycle' as const, id: job.id, title: `${job.action[0].toUpperCase()}${job.action.slice(1)} | ${job.boxLabel}`, subtitle: `${job.hostName} | ${job.node} | VMID ${job.vmid}`, status: job.status, createdAt: job.createdAt })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function renderActivityTab(content: HTMLElement, deps: {
  showProvisionJob: (id: string) => void;
  showLifecycleJob: (id: string) => void;
}) {
  const [provisions, lifecycle] = await Promise.all([
    pve.provisions().catch(() => []), pve.lifecycleJobs().catch(() => []),
  ]);
  const activity = mergeActivity(provisions, lifecycle);
  content.replaceChildren(activity.length ? el('div', { class: 'pve-list' }, activity.map((item) =>
    el('button', { type: 'button', class: 'pve-row pve-row-btn', onclick: () => item.kind === 'provision' ? deps.showProvisionJob(item.id) : deps.showLifecycleJob(item.id) }, [
      el('div', {}, [el('strong', {}, [item.title]), el('div', { class: 'pve-sub' }, [item.subtitle])]),
      el('span', { class: `pve-badge ${item.status}` }, [item.status]),
    ]))) : el('div', { class: 'pve-sub' }, ['No Proxmox activity yet.']));
}
