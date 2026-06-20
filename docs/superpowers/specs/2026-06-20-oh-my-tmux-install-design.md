# Oh My Tmux Install Option Design

## Goal

When adding a box, Tmuxifier should offer a checked-by-default option to install Oh My Tmux on the remote host if it is not already installed.

## Current Behavior

Adding a box persists the box, runs remote provisioning through `boxActions.ensureReady`, installs `tmux` if needed, creates the configured tmux session, and rolls the box back if provisioning fails. The add dialog has no Oh My Tmux control.

## User Experience

The Add box modal will include a checkbox labeled `Install Oh My Tmux if missing`. It will default to checked. If unchecked, box creation keeps the existing tmux provisioning behavior and does not modify the remote user's tmux configuration.

If checked, the server will attempt the upstream manual `~` installation steps from `gpakosz/.tmux` after tmux is available and before creating the session:

1. `cd`
2. `git clone --single-branch https://github.com/gpakosz/.tmux.git`
3. `ln -s -f .tmux/.tmux.conf`
4. `cp .tmux/.tmux.conf.local .`

The install should be idempotent. If `~/.tmux/.tmux.conf` already exists, Tmuxifier treats Oh My Tmux as installed and skips clone/symlink/copy. If installation is requested and fails, the add request fails and the server removes the newly persisted box, matching existing provisioning rollback behavior.

## Architecture

The checkbox state is a transient request option named `installOhMyTmux`. It is sent with `POST /api/boxes` but is not persisted in `boxes.json`.

`server.js` will extract `installOhMyTmux`, pass only box fields to `store.addBox`, then call `boxActions.ensureReady(box, { installOhMyTmux })`.

`boxActions.js` will keep tmux installation and session creation centralized. `buildEnsureTmuxRemote(session, startupCommand, options)` will include Oh My Tmux installation commands only when `options.installOhMyTmux` is true.

## Error Handling

The server already rolls back the box and returns the remote provisioning error as a 400 response. Oh My Tmux failures will use that path. Missing `git`, SSH/network failures from the remote host, or filesystem permission issues in the remote user's home directory will surface as add-box errors.

## Testing

Tests will be written first.

- `test/boxActions.test.js` will verify the remote script includes the upstream manual install steps only when requested and skips them when the install marker exists.
- `test/server.test.js` will verify `POST /api/boxes` passes `{ installOhMyTmux: true }` to provisioning, strips the transient option before persistence, and defaults to false if absent.
- `src/web/main.ts` and `src/web/api.ts` will be checked by the TypeScript build through the existing test/build commands.
