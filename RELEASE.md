# Releasing stride-opencode

A release of this plugin is a version bump, a changelog entry, an annotated
tag and a GitHub release — all in this one repository. There is nothing to
sync anywhere else.

## The three facts

**Where the version lives.** `package.json` (`"version"`) is the only file
that carries it. No test asserts that it matches the changelog, so keeping
the two in step is on you.

**Changelog shape — it changed over time, and the next release has to pick.**
The history shows two shapes, and both are on the record:

- **Unreleased-then-stamp** (most, though not all, releases from 1.19.0
  through 1.36.0 — 1.33.0, for one, consolidated several entries): work
  commits appended entries under `## [Unreleased]`, and the release commit
  only renamed that heading to `## [X.Y.Z] - YYYY-MM-DD` and bumped
  `package.json`. 1.35.0 is the clean example — its release commit is the one-line
  heading rename plus the one-line `package.json` bump.
- **Release-commit-writes-it** (1.37.0 and 1.38.0, the two most recent):
  work commits leave `CHANGELOG.md` alone, and the release commit writes the
  whole heading and entry and bumps `package.json`, touching nothing else.

There is no `[Unreleased]` heading today, so the second shape is what the
file is currently set up for: write the entry in the release commit. If you
reintroduce `[Unreleased]` instead, do it deliberately and say so in that
release's entry; do not leave the file half in each shape.

**Catalog: none.** OpenCode has no plugin marketplace, so there is no catalog
repository to update. Users install straight from this repository — an
`opencode.json` entry of `"github:cheezy/stride-opencode"`, optionally pinned
to a tag with `#vX.Y.Z` (see the README's install section). The package is
not published to npm. The tag is therefore what users pin to, which is why
every release gets one.

## Before you write the entry: is the top heading already tagged?

A heading that is already tagged describes a release that shipped. Adding
entries under it rewrites that record — the fleet did exactly this once, in
the lite ports, and had to move the entries to a new heading afterwards.
Check first:

```bash
git tag -l "v$(awk -F'[][]' '/^## \[[0-9]/{print $2; exit}' CHANGELOG.md)"
```

Any output means the top version heading is already released: start a new
heading rather than appending to it. No output means it is unreleased. (The
`## Release record` section near the top of the changelog is not a version
heading, and the command skips it.)

## Steps

1. Run the gate:

   ```bash
   bun test
   bun run typecheck
   ```

2. Run the top-heading check above, then write the `## [X.Y.Z] - YYYY-MM-DD`
   entry in `CHANGELOG.md` covering every commit since the last tag
   (`git log --oneline "$(git describe --tags --abbrev=0)"..HEAD`), and set
   `"version"` in `package.json` to `X.Y.Z`. Keep the existing entry style:
   `### Added — <what changed> (Wnnnn)` headings with prose underneath.

3. Commit those two files on `main` as `Release X.Y.Z - <summary>`, then push:

   ```bash
   git push origin main
   ```

4. Tag the release commit with an annotated tag and push it:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. Create the GitHub release from the changelog entry, titled
   `vX.Y.Z — <summary>`:

   ```bash
   gh release create vX.Y.Z --repo cheezy/stride-opencode \
     --title "vX.Y.Z — <summary>" --notes-file <notes.md>
   ```

6. Verify the tag, the release and the version agree:

   ```bash
   git tag -l "v$(awk -F'[][]' '/^## \[[0-9]/{print $2; exit}' CHANGELOG.md)"
   gh release view vX.Y.Z --repo cheezy/stride-opencode
   ```

## Known gaps on the record

- Four early tags have no GitHub release. That gap is accepted and recorded in
  the changelog's "Release record" section; do not backfill it. Every new tag
  gets a release.
- Older tags are a mix of annotated and lightweight. Recent releases (1.34.0
  onward) use annotated tags on the release commit; keep doing that.
- The README's version-pin example names an older tag. Refresh it in the
  release commit if you want it to show the current one.
