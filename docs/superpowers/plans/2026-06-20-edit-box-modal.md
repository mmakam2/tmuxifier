# Edit Box Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an edit button to each sidebar box that opens a modal for editing box metadata and optionally triggering provisioning.

**Architecture:** Parameterize the existing `openAddDialog` into `openBoxDialog(box?)` to share the form, validation, and provision-trigger flow between add and edit modes. Add the missing `updateBox` API method.

**Tech Stack:** TypeScript (web client), no new dependencies. Server PATCH endpoint already exists.

## Global Constraints

- Host field is readonly in edit mode, never sent in the patch
- Provisioning checkboxes (Oh My Tmux, Oh My Zsh) visible in both modes
- Edit mode defaults checkboxes to unchecked (offensive assumption: already provisioned)
- Submit button reads "Save" in edit mode, "Add" in add mode

---

### Task 1: Add `updateBox` to the client API

**Files:**
- Modify: `src/web/api.ts:12-13` (add after `removeBox`)

**Interfaces:**
- Produces: `api.updateBox(id: string, patch: Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean }): Promise<Box>` — used by Task 2 edit submit handler

- [ ] **Step 1: Add the method**

```typescript
async updateBox(id: string, patch: Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean }) {
  return j<Box>(await fetch(`/api/boxes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
},
```

Insert after line 19 (`async removeBox...`).

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: Vite build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(api): add updateBox client method"
```

---

### Task 2: Add edit button and refactor dialog

**Files:**
- Modify: `src/web/main.ts:121-168` (add edit button in `paint`)
- Modify: `src/web/main.ts:237-339` (refactor `openAddDialog` → `openBoxDialog`)

**Interfaces:**
- Consumes: `api.updateBox` from Task 1
- Produces: `openBoxDialog(box?)` — parameterized modal, used in add button handler and edit button handler

- [ ] **Step 1: Add the edit button in `paint()`**

In the `paint` function, after the refresh button and before the remove button (between lines 153-154), add:

```typescript
const edit = document.createElement('button');
edit.className = 'edit';
edit.title = 'Edit';
edit.textContent = '✎';
edit.addEventListener('click', (e) => {
  e.stopPropagation();
  openBoxDialog(b);
});

li.append(dotEl, nameEl, refresh, edit, rm);
```

And update the `append` call to include `edit` (line 165 changes from `refresh, rm` to `refresh, edit, rm`).

- [ ] **Step 2: Add edit button CSS**

In `src/web/style.css`, after the `.box .refresh` rule (line 62), add:

```css
.box .edit { background: none; border: none; color: #6e7681; cursor: pointer; font-size: 13px; }
```

- [ ] **Step 3: Refactor `openAddDialog` → `openBoxDialog(box?)`**

Replace the `openAddDialog` function signature:

```typescript
function openBoxDialog(box?: Box) {
```

Inside the function, determine mode:

```typescript
const isEdit = !!box;
```

Change the title line:

```typescript
title.textContent = isEdit ? 'Edit box' : 'Add box';
```

Change the submit button text:

```typescript
submit.textContent = isEdit ? 'Save' : 'Add';
```

For the host field, make it disabled in edit mode:

```typescript
const hostInput = field('host', 'Host or alias', { placeholder: 'e.g. 192.168.3.245' });
if (isEdit) {
  const input = hostInput.querySelector('input')!;
  input.value = box.label === box.host && isEdit ? box.host : box.host; // Always show actual host
  input.disabled = true;
  input.style.opacity = '0.6';
}
```

Wait, simpler approach — just set the host field value and disable it if in edit mode. Replace the `field('host', ...)` call:

```typescript
const hostWrap = field('host', 'Host or alias', { placeholder: 'e.g. 192.168.3.245' });
if (isEdit) {
  const hInput = hostWrap.querySelector('input')!;
  hInput.value = box.host;
  hInput.disabled = true;
  hInput.style.opacity = '0.6';
}
```

Pre-populate fields in edit mode (after the other field() calls):

```typescript
if (isEdit) {
  fields.label.value = box.label !== box.host ? box.label : '';
  if (box.user) fields.user.value = box.user;
  if (box.port) fields.port.value = String(box.port);
  if (box.proxyJump) fields.proxyJump.value = box.proxyJump;
}
```

Default checkboxes to unchecked in edit mode:

```typescript
if (isEdit) {
  installOhMyTmuxInput.checked = false;
  installOhMyZshInput.checked = false;
}
```

Update the submit handler — after validation (host required for add, port validation), add edit/add branching. Replace the submit block starting from `submit.disabled = true`:

```typescript
submit.disabled = true;
try {
  if (isEdit) {
    const patch: any = {};
    const label = fields.label.value.trim(); if (label) patch.label = label;
    const user = fields.user.value.trim(); patch.user = user || null;
    const jump = fields.proxyJump.value.trim(); patch.proxyJump = jump || null;
    const portRaw = fields.port.value.trim();
    if (portRaw) {
      const port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; submit.disabled = false; return; }
      patch.port = port;
    } else {
      patch.port = null;
    }
    const box = await api.updateBox(box!.id, patch);
    close();
    await refresh();
    if (installOhMyTmuxInput.checked || installOhMyZshInput.checked) {
      openProvisionPanel(box, {
        ohMyTmux: installOhMyTmuxInput.checked,
        ohMyZsh: installOhMyZshInput.checked,
      });
    }
  } else {
    const host = fields.host.value.trim();
    if (!host) { err.textContent = 'Host is required'; submit.disabled = false; return; }
    const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh: installOhMyZshInput.checked };
    const label = fields.label.value.trim(); if (label) spec.label = label;
    const user = fields.user.value.trim(); if (user) spec.user = user;
    const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
    const portRaw = fields.port.value.trim();
    if (portRaw) {
      const port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; submit.disabled = false; return; }
      spec.port = port;
    }
    const newBox = await api.addBox(spec);
    close();
    openProvisionPanel(newBox, {
      ohMyTmux: installOhMyTmuxInput.checked,
      ohMyZsh: installOhMyZshInput.checked,
    });
  }
} catch (e: any) {
  err.textContent = e?.message || `Could not ${isEdit ? 'save' : 'add'} box`;
  submit.disabled = false;
}
```

Update the add button handler to call `openBoxDialog()` (no argument):

Change line 108:
```typescript
app.querySelector('#add')!.addEventListener('click', () => openBoxDialog());
```

And remove the `openAddDialog` name — rename the function definition on line 237 to `function openBoxDialog(box?: Box)`.

- [ ] **Step 4: Verify with build and lint**

Run: `npm run build`
Expected: Vite build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(ui): add edit box modal with provisioning support"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify in browser**
  - Confirm edit button ✎ appears on each box in the sidebar
  - Click edit → modal opens with fields pre-populated
  - Host is disabled (grayed out)
  - Change label, save → sidebar updates
  - Check provisioning checkbox, save → provision panel slides out
  - Edit button doesn't appear on old boxes? Click to verify
  - Add button still works (creates new box + provisions)

- [ ] **Step 3: Commit any fixups**

Only if manual testing reveals issues.
