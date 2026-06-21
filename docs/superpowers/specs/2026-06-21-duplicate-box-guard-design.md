# Duplicate Box Guard Design

## Summary

Tmuxifier should reject adding or editing a box when the resulting host or label would duplicate another stored box. The duplicate comparison is case-insensitive and ignores surrounding whitespace.

## Behavior

- Adding a box fails if its normalized host matches an existing box host.
- Adding a box fails if its normalized label matches an existing box label.
- Editing a box ignores the box being edited, but fails if the resulting host or label matches any other box.
- A missing label still defaults to the host before duplicate checks, so adding `{ host: "prod" }` conflicts with an existing label of `Prod`.
- Existing UI error handling remains unchanged: backend validation errors surface in the modal through the current API helper.
- SSH config import continues skipping duplicates. Store-level validation protects import and any future non-UI callers.

## Architecture

The guard belongs in `src/server/store.js` because all persisted box mutations pass through `createStore`. A small helper will canonicalize comparison values with `String(value).trim().toLowerCase()` for strings, then check candidate host and label against the existing list while optionally ignoring the current box id during edits.

`server.js` can keep its existing `400 { error }` handling. `src/web/main.ts` already displays thrown API messages in the add/edit modal, so no web change is required for the initial guard.

## Error Handling

Validation errors should be specific and stable:

- `box host already exists`
- `box label already exists`

The store throws `Error` with these messages. The API routes already convert store errors into `400` responses.

## Testing

Add focused store tests for duplicate host and label rejection on add and update, including case-insensitive matching and self-ignore during a no-op edit. Add one API test to prove a duplicate add returns `400` with the store error message.
