# Releasing

`watch-tail` uses [changesets](https://github.com/changesets/changesets). A release is a merge,
not a ceremony: you describe what changed while you are still in the change, and the automation
turns that into a version bump, a changelog and a staged npm package.

## The concept

A **changeset** is a small markdown file in `.changeset/` that records two things: which package is
affected and whether the change is `patch`, `minor` or `major`, plus a sentence for the changelog.
It is reviewed with the code it describes, so the reason for the bump is never a guess made later.

From there the tool does the bookkeeping:

1. **Pending changesets** accumulate on `main`. The _Version PR_ workflow keeps a single
   "Release: version packages" pull request up to date, showing the next version and the changelog
   entries it would produce. Preview it any time with `pnpm changeset status`.
2. **Merging the Version PR** runs `changeset version`, which consumes the pending changesets,
   bumps `package.json` and writes `CHANGELOG.md`. Nothing is published yet.
3. **The release workflow** notices the new version (via `changeset publish-plan`), stages it to npm,
   and tags the commit with `changeset git-tag` (`v0.1.0`, `v0.2.0-beta.0`, ...).
4. **A human approves the staged package**, which is the moment it becomes installable.

Only step 4 is manual, and it is deliberately so.

## Publishing is staged

`changeset publish` uploads straight to the registry, which is not how this package ships. The
release workflow uses `npm stage publish` instead: the tarball goes to npm's staging area, and it
does not exist for users until someone with 2FA approves it. That means:

- the trusted publisher can be restricted to _stage publish only_;
- nothing reaches `latest` because a workflow went wrong at 3am;
- a rejected build is simply never approved.

It also means **no npm token exists anywhere** - authentication is GitHub OIDC trusted publishing,
scoped to the `publish` job, which is the only job that can mint an id-token. Build and test code
never sees publish credentials.

## One-time setup

0. **Turn staging on.** The release workflow only stages to npm when the repository variable
   `NPM_PUBLISH_ENABLED` is `true` (Settings → Secrets and variables → Actions → Variables). It is
   unset on purpose: until the trusted publisher below exists, a staging attempt could only fail, so
   the workflow verifies the release commit and stops. Set the variable last, after steps 1-5.
1. **Two-factor authentication** on npm and GitHub, ideally with a security key.
2. **Trusted publisher** for `watch-tail` on npm (or, before the package exists, from the CLI):

   ```bash
   npm trust github watch-tail --repo antstanley/watch-tail --file release.yml --allow-stage-publish
   ```

   On the npm website: _Package → Settings → Trusted Publishing_, repository
   `antstanley/watch-tail`, workflow `release.yml`, "Allow npm stage publish" checked.

3. **Require 2FA for publishing** (disables token publishing):

   ```bash
   npm access set mfa=publish watch-tail
   ```

4. **GitHub environment `publish`** (Settings → Environments) with a required reviewer, limited to
   the `main` branch, and no admin bypass. The publish job names this environment, so it waits for
   that approval.
5. **Repository security** (Settings → Actions → General): require actions pinned to a full-length
   commit SHA, require approval for first-time contributors, and set the default workflow token to
   read-only. Protect `main` with a pull-request rule.
6. Optional upkeep: `npx actions-up` refreshes action SHAs, `zizmor .github/workflows/release.yml`
   lints the workflows for injection and permission problems.

## Cutting a release

```bash
pnpm changeset                       # describe the change (patch/minor/major + summary)
git add .changeset && git commit -m "Add changeset" && git push
```

Merge the resulting "Release: version packages" PR, then watch the release workflow: it stages the
tarball and creates the tag and GitHub release. Approve the staged package to ship it:

```bash
npm stage approve                    # or the npmjs "Staged packages" page
```

Staged packages are listed at <https://www.npmjs.com/settings/~/staged-packages>; the workflow
writes the staging id to the run summary.

## Prereleases

```bash
pnpm changeset pre enter beta        # then add changesets and merge the Version PR
pnpm changeset pre exit              # back to normal releases
```

A prerelease version stages under its own dist-tag (`0.2.0-beta.1` → `beta`), so it never becomes
`latest`. `changeset publish-plan` reports the dist-tag to use.

## Local checks before merging a changeset

```bash
pnpm changeset status    # what the next version will be
pnpm verify              # types, tests, lint, format, knip, build
pnpm test:e2e            # floci integration (needs floci running)
pnpm test:cli            # the built CLI serves the UI
pnpm publish:check       # publint, the exact tarball contents, size budget, imports
```

## Manual publishing (break glass)

Only if trusted publishing is unavailable. `mfa=publish` means this needs a 2FA prompt:

```bash
pnpm build
npm publish --ignore-scripts --access public --tag latest
```

Never commit an npm token, and never add one to this repository's secrets.

## Troubleshooting

Two failures showed up the first time this pipeline ran for real, and both are fixed in
`.github/workflows/release.yml`. They are worth knowing about:

- **`changeset git-tag` reports a tag but the push finds no ref.** The runner starts without a git
  identity, and tag creation needs one; changesets reported success while the tag was never written.
  The tag job now configures a bot identity, verifies the tag exists (creating it directly if
  changesets did not) and pushes only when the remote is missing it.
- **A re-run tries to stage the version that is already staged.** The publish step treats
  "already staged"/"already published" as a notice rather than a failure, because that version is
  simply waiting for approval.

If the `Version PR` workflow fails with _"GitHub Actions is not permitted to create or approve pull
requests"_, the repository setting is off: **Settings → Actions → General → Workflow permissions →
Allow GitHub Actions to create and approve pull requests**. The default workflow permission should
stay read-only; only this workflow asks for more.

After approval, verify the public dist-tag (staging alone does not update it):

```bash
npm view watch-tail dist-tags --json
```

For a stable release, `latest` should match the released version. The package defaults to
`latest`; prerelease workflows pass their own tag explicitly.
