# npm CLI Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the native Postplan CLI through `@notsuhas/postplan` while retaining the standalone installer and one Go implementation.

**Architecture:** A Node launcher resolves one of four optional platform packages and executes its bundled Go binary. A release preparation script stages binaries and synchronizes package versions before the tag workflow publishes platform packages followed by the launcher.

**Tech Stack:** Go 1.26, Bun 1.4, Node.js 20+, npm packages, GitHub Actions

## Global Constraints

- Keep npm-specific files under `packages/cli/npm`.
- Keep the Go CLI as the only command implementation.
- Support macOS and Linux on arm64 and x64.
- Do not use npm lifecycle download scripts.
- Keep `curl | sh` installation and GitHub release assets unchanged.
- Prevent npm-managed binaries from self-updating inside `node_modules`.
- The first published unified version must be greater than existing npm version `1.1.0`.

---

### Task 1: Native launcher and package manifests

**Files:**
- Create: `packages/cli/npm/postplan/src/platform.ts`
- Create: `packages/cli/npm/postplan/bin/postplan.js`
- Create: `packages/cli/npm/postplan/test/platform.test.ts`
- Create: `packages/cli/npm/postplan/package.json`
- Create: `packages/cli/npm/postplan/README.md`
- Create: `packages/cli/npm/platforms/*/package.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `packageName(platform, arch): string` and `binaryPath(platform, arch, resolver): string`.
- Produces: a `postplan` npm bin that forwards arguments, stdio, exit status, and `POSTPLAN_MANAGED_BY=npm`.

- [x] Write tests for supported mappings, unsupported targets, and missing optional dependencies.
- [x] Run `bun test packages/cli/npm/postplan/test/platform.test.ts` and verify failure because the module does not exist.
- [x] Implement the mapping module and launcher.
- [x] Add the launcher and four platform manifests with exact optional dependencies.
- [x] Add focused root test and preparation scripts without coupling the packages to the app workspaces.
- [x] Run the focused tests and verify they pass.

### Task 2: npm-managed update behavior

**Files:**
- Modify: `packages/cli/internal/cli/upgrade_io_test.go`
- Modify: `packages/cli/internal/cli/upgrade_io.go`

**Interfaces:**
- Consumes: `POSTPLAN_MANAGED_BY=npm` from the launcher.
- Produces: disabled automatic updates and an actionable manual-upgrade error for npm-managed execution.

- [x] Add failing Go tests for the npm management marker.
- [x] Run the focused Go tests and verify the new cases fail.
- [x] Add the minimal management guard to the update paths.
- [x] Run the focused and full CLI tests.

### Task 3: Deterministic release staging

**Files:**
- Create: `packages/cli/npm/scripts/prepare-packages.ts`
- Create: `packages/cli/npm/scripts/prepare-packages.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `preparePackages(version, distDir, npmDir)` which validates a stable version, copies four release binaries, and synchronizes five manifests.

- [x] Write failing tests using temporary package and release directories.
- [x] Run the focused test and verify the missing implementation failure.
- [x] Implement preparation with explicit target metadata and no shell interpolation.
- [x] Ignore staged package executables and package tarballs.
- [x] Run preparation tests and npm pack dry-runs against locally built binaries.

### Task 4: Release workflow and documentation

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `packages/cli/internal/cli/SKILL.md`

**Interfaces:**
- Consumes: existing four Go builds and an `NPM_TOKEN` repository secret.
- Produces: GitHub assets plus five npm packages from the same release tag.

- [x] Update the build step to retain uncompressed binaries until both distribution paths are staged.
- [x] Add npm setup, preparation, dry-run validation, and ordered publication with provenance.
- [x] Document npm/npx installation, self-hosted URL configuration, and npm-managed upgrades.
- [x] Run `bun run build:generated` because the canonical CLI skill changed.

### Task 5: Verification and delivery

**Files:**
- Verify all modified files.

**Interfaces:**
- Produces: a pushed feature branch and pull request.

- [x] Run npm launcher/preparation tests and package dry runs.
- [x] Run `bun run typecheck`, `bun run lint`, `bun run format:check`, and relevant root tests.
- [x] Run `gofmt`, `go vet ./...`, and `go test ./...` in `packages/cli`.
- [ ] Review `git diff`, commit with Conventional Commits, and push.
- [ ] Open a pull request with test evidence and the `v1.2.0+` release prerequisite.
