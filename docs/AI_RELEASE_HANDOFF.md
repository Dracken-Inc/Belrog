# AI Release Handoff

Read this before helping with Belrog commits, tags, or desktop releases.

## Important

Do **not** tell the user to build or sign the Mac app manually unless GitHub Actions is broken and the user explicitly asks for a manual fallback.

## Normal release flow (0.6.x)

Releases are cut from **whichever branch carries the work** — currently
`feat/shot-plan-schema-freeze` — not from `main`, which lags behind at v0.6.2
(see `docs/AI_CURRENT_HANDOFF.md`). Exact sequence:

1. Verify first: `npm run test:all` matches the documented baseline, and
   `npx vite build` passes — run `npx vite build` before **any** commit that
   touches `src/**/*.jsx` (`node --test` never parses JSX, so tests cannot
   catch a JSX syntax error).
2. `git push origin <release-branch>`
3. `npm version <ver> --no-git-tag-version`
4. `npm install --package-lock-only`
5. Commit `chore(release): v<ver>` (package.json + package-lock.json only)
6. `git push origin <release-branch>`
7. `git tag -a v<ver> -m "belrog v<ver>"` then `git push origin refs/tags/v<ver>`
8. Poll `https://api.github.com/repos/Dracken-Inc/Belrog/actions/runs?branch=<release-branch>`
   with the PAT from `~/.git-credentials` until the release workflow completes.
9. **The workflow leaves the release as a DRAFT.** `GET /releases?per_page=3`,
   find `v<ver>`, `PATCH {"draft": false}`, and verify **4 assets** (cross-check
   `GET /releases/tags/v<ver>`).
10. Notify Henry.

Tag numbering: 0.6.x tags are strictly increasing (… v0.6.51, v0.6.52, …).
**Never reuse or force-push an existing number.**

The workflow is:

```text
.github/workflows/release.yml
```

The release process doc is:

```text
docs/RELEASE_PROCESS.md
```

The secrets/setup doc is:

```text
docs/CI_SECRETS.md
```

## What Gets Built

The GitHub Actions release workflow uploads:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

Do not upload `.blockmap` or `latest*.yml` files unless auto-update support is added later.

## Release Checklist

1. Check git status.
2. Do not commit generated release folders or local media files unless the user explicitly asks.
3. Confirm `package.json` has the new release version.
4. Confirm `package-lock.json` matches the same version.
5. Run `npm run build`.
6. Run the full test suite and compare against the documented baseline in
   `docs/AI_CURRENT_HANDOFF.md` — **CI does not run tests**:
   ```bash
   node --test 'tests/**/*.test.*' 'src/**/*.test.*' 'electron/**/*.test.*'
   ```
   No new failures vs. the baseline. Never delete, skip, or weaken a failing
   test to get green; fix it or report it to Henry.
7. Commit the release changes.
8. Push `main`.
9. Create and push the version tag:

```bash
git tag -a v0.6.52 -m "belrog v0.6.52"
git push origin refs/tags/v0.6.52
```

10. Ask the user to check `Actions > Release Desktop Builds`.
11. When the jobs are green, ask the user to review and publish the draft release.

## If GitHub Actions Fails

Open the failed job and inspect the last failing step.

Common cases:

- Windows upload fails: check artifact filenames in `package.json` and `.github/workflows/release.yml`.
- macOS signing fails: check GitHub secrets from `docs/CI_SECRETS.md`.
- macOS notarization fails: verify Apple credentials and agreements.

## Safety Rules

- Never commit `.p12` files.
- Never commit Apple passwords.
- Never commit app-specific passwords.
- Never commit API keys.
- Never commit GitHub tokens.
- Keep secrets in GitHub repository secrets only.

## Manual Mac Builds

Manual Mac builds are now a fallback, not the default.

Only use the Mac manually if:

- GitHub Actions is broken, and
- the user explicitly asks for a manual Mac build.
