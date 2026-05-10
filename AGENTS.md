## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:
1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes

## Publish and Release Flow

This project uses Conventional Commits, pnpm, and GitHub Actions. Follow this checklist when releasing.

### 1. Commit with Conventional Commits

All commits must follow the `type(scope): description` format. Types that trigger releases:

- `feat` -> minor bump (new functionality)
- `fix` -> patch bump (bug fix)
- `feat!` or `BREAKING CHANGE` in body -> major bump

Other types (`chore`, `ci`, `docs`, `refactor`, `perf`, `build`, `test`, `style`) do not affect the version but are still tracked in the changelog if user-facing.

### 2. Update CHANGELOG.md

Before releasing, run the `/changelog` prompt. It reads git history and updates `CHANGELOG.md` following the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

- `/changelog` adds only missing versions
- `/changelog rewrite` regenerates the entire file

Review the output before committing.

### 3. Generate Release Notes

Run the `/release` prompt to create or update `releases/vX.Y.Z.md`. This file is used as the body of the GitHub Release.

- `/release` targets the latest tag
- `/release v1.2.0` targets a specific tag

Review the output before committing.

### 4. Bump, Tag, and Push

Use one of these pnpm scripts to bump the version, create a git tag, and push both:

```bash
pnpm release:patch   # 1.0.0 -> 1.0.1
pnpm release:minor   # 1.0.0 -> 1.1.0
pnpm release:major   # 1.0.0 -> 2.0.0
```

This runs `pnpm version` which:
- Updates `package.json` version
- Creates a commit: `chore: release X.Y.Z`
- Creates a git tag `vX.Y.Z`
- Pushes the commit and tag to origin

### 5. Automated npm Publish

The GitHub Actions workflow (`.github/workflows/publish.yml`) triggers on any tag push matching `v*`. It:

1. Installs dependencies with `pnpm install --frozen-lockfile`
2. Runs `pnpm build`
3. Publishes to the npm registry via `JS-DevTools/npm-publish`

No manual publish step is needed. If it fails, check the Actions tab on GitHub.

### 6. Create GitHub Release

After the tag is pushed, create a GitHub Release:

1. Go to https://github.com/nielpattin/documine/releases/new
2. Choose the tag that was just pushed
3. Set the title to the version (e.g. `v1.2.0`)
4. Copy the contents of `releases/vX.Y.Z.md` into the description
5. Publish the release

### Release Checklist Summary

```
1. Write code, commit with conventional commits
2. /changelog              (update CHANGELOG.md)
3. /release                (generate releases/vX.Y.Z.md)
4. git add CHANGELOG.md releases/ && git commit -m "docs: update changelog and release notes"
5. pnpm release:patch      (or minor/major)
6. Create GitHub Release from releases/vX.Y.Z.md
```