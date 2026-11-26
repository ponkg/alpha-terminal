# Alpha public-site redesign — restore instructions

This redesign is isolated on `design/dragonfly-inspired-2026-11-27`.

## Untouched pre-redesign snapshot
The original site is preserved on:

- `backup/pre-dragonfly-redesign-2026-11-27`

That branch was created from `main` before any redesign edits. Do not push redesign commits to it.

## Restore options

### Safest option before merging
Close the redesign pull request and keep `main` unchanged. The Render production site will continue to use its current deployment branch.

### Revert after merging
Use GitHub's **Revert** action on the merge commit for this pull request. That creates a new commit which reverses the redesign without rewriting history.

### Restore original public files manually
Compare or restore these paths from `backup/pre-dragonfly-redesign-2026-11-27`:

- `public/index.html`
- `public/docs/index.html`
- `public/docs/use-cases/index.html`

No backend routes, authentication, waitlist schema, market-data services, terminal application logic, or Render configuration were changed by this redesign.

## Scope
The redesign is limited to public-facing HTML/CSS and public copy. Existing terminal windows, login/waitlist forms, and backend IDs were retained in the homepage document.
