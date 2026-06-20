# Oh My Zsh Install Option Design

## Goal

When adding a box, Tmuxifier should offer a checked-by-default option to install Oh My Zsh on the remote host if it is not already installed.

## Current Behavior

Adding a box persists the box, runs remote provisioning through `boxActions.ensureReady`, installs `tmux` if needed, optionally installs Oh My Tmux (via `installOhMyTmux` transient option), creates the configured tmux session, and rolls the box back if provisioning fails. The add dialog has an Oh My Tmux checkbox; it does not have an Oh My Zsh control.

## User Experience

The Add box modal will include a checkbox labeled `Install Oh My Zsh if missing`. It will default to checked and sit below the existing Oh My Tmux checkbox. The two options are independent — each can be toggled without affecting the other.

If checked, the server will:

1. Install `zsh` via the remote host's package manager (same detection pattern as the existing tmux install)
2. Fetch and run the upstream Oh My Zsh install script non-interactively:
   - `RUNZSH=no CHSH=yes sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"`
   - Fall back to `wget -O-` if `curl` is unavailable
   - `RUNZSH=no` prevents the script from launching an interactive zsh session
   - `CHSH=yes` tells it to change the user's default shell to zsh

The install should be idempotent. If `~/.oh-my-zsh` already exists, Tmuxifier treats Oh My Zsh as installed and skips the install steps. If installation is requested and fails, the add request fails and the server removes the newly persisted box, matching existing provisioning rollback behavior.

## Architecture

The checkbox state is a transient request option named `installOhMyZsh`. It is sent with `POST /api/boxes` but is not persisted in `boxes.json`.

`server.js` will extract both `installOhMyTmux` and `installOhMyZsh`, pass only box fields to `store.addBox`, then call `boxActions.ensureReady(box, { installOhMyTmux, installOhMyZsh })`.

`boxActions.js` `buildEnsureTmuxRemote(session, startupCommand, options)` will include zsh installation and Oh My Zsh installation commands only when `options.installOhMyZsh` is true. The zsh steps slot in after the existing tmux/oh-my-tmux provisioning and before the tmux session creation.

## Error Handling

The server already rolls back the box and returns the remote provisioning error as a 400 response. Oh My Zsh failures will use that path. Missing `curl`/`wget`, SSH/network failures from the remote host, `chsh` permission issues, or filesystem permission problems in the remote user's home directory will surface as add-box errors.

## Testing

Tests will be written first.

- `test/boxActions.test.js` will verify the remote script includes the zsh package-manager install and the upstream Oh My Zsh install steps only when requested, and skips them when `~/.oh-my-zsh` already exists.
- `test/server.test.js` will verify `POST /api/boxes` passes `{ installOhMyZsh: true }` to provisioning, strips the transient option before persistence, and defaults to false if absent. The existing `installOhMyTmux` transient-option test will be extended to cover both options simultaneously.
- `src/web/main.ts` and `src/web/api.ts` will be checked by the TypeScript build through the existing test/build commands.
