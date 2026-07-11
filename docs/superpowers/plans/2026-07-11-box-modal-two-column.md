# Two-Column Box Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Add/Edit Box modal becomes a 560px two-column layout with a scrollable body and pinned Cancel/Save footer, so its actions can never be clipped off-screen again.

**Architecture:** Pure regrouping in `openBoxDialog` (`src/web/main.ts`): the form gains `box-modal`, its children are rearranged into `title → div.modal-body → err → actions`, with two `div.field-grid` wrappers pairing compact fields. New opt-in CSS classes in `style.css`; all other modals keep their 340px look. No behavior, handler, or server changes.

**Tech Stack:** TypeScript web client (`src/web/`), Vite, plain CSS.

**Spec:** `docs/superpowers/specs/2026-07-11-box-modal-two-column-design.md`

## Global Constraints

- Behavior-preserving: same fields, same validation, same submit path — only element grouping and CSS change.
- The `err` paragraph and `actions` row live OUTSIDE the scrollable body (a failed save can never be scrolled away).
- New classes (`box-modal`, `modal-body`, `field-grid`) are opt-in; local-shell/fleet/confirm modals must be untouched.
- CSS values verbatim from the spec: `width: 560px; max-height: 92vh`; scrollbar clearance `padding-right: 14px; margin-right: -14px`; grid collapse breakpoint `max-width: 620px`.
- Gate: `npm run typecheck && npm run build` clean + `npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js test/proxmoxAssociation.test.js` green (no DOM tests exist; the reviewer/manual walkthrough gates the layout).

---

### Task 1: Two-column box modal

**Files:**
- Modify: `src/web/main.ts` (in `openBoxDialog`: the `form.className` line ~1116 and the `form.append(...)` block ~1150-1165)
- Modify: `src/web/style.css` (append after the `.modal.settings-modal` rules, ~line 266)

**Interfaces:**
- Consumes: everything already in scope inside `openBoxDialog` — `title`, `hostWrap`, the `field(name, label, opts)` helper, `tagDatalist`/`tagListId`, `sessionWrap`, `installOhMyTmux`, `shellGroup`, `proxmoxAssociation`, `err`, `actions`.
- Produces: nothing consumed elsewhere (classes are private to this modal).

- [ ] **Step 1: Restructure the form assembly in `src/web/main.ts`**

Change the form's class (currently `form.className = 'modal';` inside `openBoxDialog`):

```ts
  form.className = 'modal box-modal';
```

Replace the current assembly block:

```ts
  form.append(
    title,
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('tag', 'Tag', { placeholder: 'prod, staging, db', list: tagListId }),
    tagDatalist,
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    sessionWrap,
    installOhMyTmux,
    shellGroup,
    ...(proxmoxAssociation ? [proxmoxAssociation.element] : []),
    err,
    actions,
  );
```

with:

```ts
  // Two-column body: compact fields pair up (Host|Label, Tag|User, Port|ProxyJump),
  // the session picker and Proxmox section span full width, and err/actions sit
  // outside the scroll region so they are always visible (pinned footer).
  const fieldGrid = document.createElement('div');
  fieldGrid.className = 'field-grid';
  fieldGrid.append(
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('tag', 'Tag', { placeholder: 'prod, staging, db', list: tagListId }),
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
  );

  const setupGrid = document.createElement('div');
  setupGrid.className = 'field-grid';
  setupGrid.append(shellGroup, installOhMyTmux);

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';
  modalBody.append(
    fieldGrid,
    tagDatalist,
    sessionWrap,
    setupGrid,
    ...(proxmoxAssociation ? [proxmoxAssociation.element] : []),
  );

  form.append(title, modalBody, err, actions);
```

Note the DOM-order change is confined to this block: the six paired fields keep their original
relative order (grid auto-placement yields Host|Label, Tag|User, Port|ProxyJump); `tagDatalist`
renders nothing and merely moves inside the body; nothing else in `openBoxDialog` changes.

- [ ] **Step 2: Append the CSS to `src/web/style.css`**

After the `.modal.settings-modal h3 { … }` rule, add:

```css
.modal.box-modal { width: 560px; max-height: 92vh; }
/* Scrollable field area with pinned title/err/actions. The padding/margin pair
   clears an appearing scrollbar so it never overlaps inputs (same trick as .pve-content). */
.modal.box-modal .modal-body { display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 14px; margin-right: -14px; }
.modal .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
@media (max-width: 620px) { .modal .field-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build && npx vitest run test/settingsForm.test.js test/proxmoxWebClient.test.js test/webIndex.test.js test/proxmoxAssociation.test.js`
Expected: all clean/green.

Static self-check: confirm `err` and `actions` are appended to `form`, not `modalBody`; grep the diff for any change outside the assembly block, the class line, and the CSS append — there must be none.

- [ ] **Step 4: Manual walkthrough (spec checklist — perform in the running app or a Playwright-driven local build)**

1. Add-box mode: two columns (Host|Label, Tag|User, Port|ProxyJump), session picker full-width, shell radios beside the Oh-My-Tmux checkbox, no Proxmox section, nothing clipped.
2. Edit mode on a linked box: Proxmox section full-width below the setup row.
3. Shrink the window height: only the field area scrolls; title and Cancel/Save stay visible.
4. Narrow the window under 620px: fields stack to one column.
5. Session-chip pick, ⟳ probe, save, and cancel behave exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "fix(ui): two-column box modal with pinned footer"
```
