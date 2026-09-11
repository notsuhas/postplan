# npm CLI Distribution Design

## Goal

Publish the existing Postplan Go CLI through the already-owned `@notsuhas/postplan` npm package so users can run `npx @notsuhas/postplan` or install it globally, without replacing the standalone `curl | sh` installation or maintaining a second CLI implementation.

## Distribution architecture

The npm distribution has one JavaScript launcher package and four platform-specific binary packages:

- `@notsuhas/postplan`
- `@notsuhas/postplan-darwin-arm64`
- `@notsuhas/postplan-darwin-x64`
- `@notsuhas/postplan-linux-arm64`
- `@notsuhas/postplan-linux-x64`

The launcher declares the four binary packages as `optionalDependencies`. Each binary package uses npm's `os` and `cpu` metadata, so npm installs only the package matching the current machine. The launcher resolves that package, invokes its `bin/postplan` executable with inherited standard streams, and forwards signals and exit status. Unsupported platforms and incomplete installations produce short actionable errors.

This design avoids npm lifecycle download scripts. The executable is present in the npm package, npm verifies package integrity, and installations work in environments that disable `postinstall` scripts.

## Source layout

All npm-specific source stays under `packages/cli/npm`:

```text
packages/cli/npm/
├── postplan/
│   ├── bin/postplan.js
│   ├── src/platform.js
│   ├── test/platform.test.ts
│   ├── README.md
│   └── package.json
├── platforms/
│   ├── darwin-arm64/package.json
│   ├── darwin-x64/package.json
│   ├── linux-arm64/package.json
│   └── linux-x64/package.json
└── scripts/
    ├── prepare-packages.ts
    └── prepare-packages.test.ts
```

The platform directories contain only publish metadata in Git. The release job copies the freshly built Go executable into each platform package immediately before packing and publishing. Generated binaries and tarballs remain ignored.

The npm packages become a workspace only where that improves local testing; the Go module remains independent and unchanged in `packages/cli`.

## Runtime behavior

The launcher maps Node's `process.platform` and `process.arch` values to the four supported package names. It runs the native executable synchronously with `stdio: "inherit"`, preserving normal terminal interaction, stdin piping, and the native exit code.

The launcher sets `POSTPLAN_MANAGED_BY=npm`. The Go CLI uses that marker to skip background self-update and makes `postplan upgrade` explain that npm-managed installations should be updated with npm. This prevents the native updater from mutating an executable inside `node_modules` while retaining current self-update behavior for `curl | sh` installations.

Node 20 is the minimum runtime, matching the repository's existing engine floor. npm installation adds Node as a requirement only for the npm route; the standalone route remains runtime-free.

## Release flow

The existing tag-triggered release job continues to cross-compile the same four Go binaries and publish the GitHub release assets used by `install.sh`. After that build, it:

1. derives the npm version from the `vX.Y.Z` Git tag;
2. copies each uncompressed executable into its platform package;
3. writes the same version into all five package manifests and exact optional-dependency versions into the launcher manifest;
4. runs package tests and `npm pack --dry-run` validation;
5. publishes the four platform packages first; and
6. publishes `@notsuhas/postplan` last.

Publishing uses the repository's npm authentication secret and provenance. Publishing the launcher last prevents a visible launcher version from referencing platform versions that are not yet available.

The existing npm package already has versions `1.0.0` and `1.1.0`; therefore the first unified GitHub/npm release tag must be a new version greater than `1.1.0` (for example `v1.2.0`). Release documentation will call this out rather than silently moving npm's `latest` tag backward.

## Tests and validation

Tests cover platform-to-package mapping, unsupported platforms, missing optional dependencies, argument forwarding, exit-code forwarding, npm-managed update suppression, and package preparation from a synthetic release directory. Package dry-runs verify that each tarball contains only its intended launcher or executable and metadata.

Before handoff, the repository-required TypeScript checks and all Go tests run, along with the npm packaging tests and release-package dry runs.

## Documentation

The README and install guidance present npm as an additional installation method, not a replacement. The canonical CLI skill continues to recommend the instance-bound installer because `/api/install` seeds the correct self-hosted API URL; npm users set `POSTPLAN_API_URL` explicitly when they are not using the default instance.
