# Releasing ah-engine

ah-engine has its own semver, separate from the plugin. A release is tagged `ah-engine-vX.Y.Z` and is built by `.github/workflows/ah-engine-release.yml` in two steps. The plugin pins one exact engine version in `ah-engine.lock` at the repo root.

## Files

| File | Purpose |
|---|---|
| `ah-engine/targets.json` | Target set and runner per target. The only place the target list lives; the workflow matrix is read from it. |
| `ah-engine/rust-toolchain.toml` | Pinned Rust toolchain. |
| `ah-engine/scripts/build.sh` | Local release build for the host or `--target <triple>`. Prints the artifact path and sha256. |
| `ah-engine/scripts/fingerprint.sh` | Build fingerprint (see below). |
| `ah-engine/scripts/package.sh` | Deterministic `ah-engine-vX.Y.Z-<triple>.tar.gz` plus `.sha256`. |
| `ah-engine/scripts/package-src.sh` | Vendored source tarball `ah-engine-vX.Y.Z-src.tar.gz` plus `.sha256`. |
| `ah-engine/scripts/update-lock.sh` | Writes `ah-engine.lock` from a directory of assets. |
| `ah-engine.lock.example` | Example lock file from a local host build. |

## Fingerprint

`fingerprint.sh` prints the sha256 of a listing of per-file sha256 hashes, sorted by path. Inputs (relative to `ah-engine/`): `src/`, `build.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `targets.json`, `scripts/build.sh`, `scripts/package.sh`, `scripts/package-src.sh`, `README.md`, `../LICENSE`. Absent paths are skipped, and symlinks in these paths are rejected. Tests, other docs and CI workflows are not inputs, and neither are the engine's settings, tables, messages and rules: they ship with the plugin (`plugins/anti-hall/engine/`) and are read at run time, so tuning them never changes the binary. The result does not depend on mtimes, checkout path or OS.

## Procedure

1. Change the engine and bump `version` in `ah-engine/Cargo.toml`. Prepare skips the build when the fingerprint equals the one in `ah-engine.lock`.
2. **Prepare.** Run the `ah-engine-release` workflow (workflow_dispatch) on the release branch. For each entry in `targets.json` it builds with `cargo build --release --locked`, packages `ah-engine-vX.Y.Z-<triple>.tar.gz` (binary, LICENSE, README under one top-level directory), then runs `cargo test --release --locked` in a separate target directory. It also builds `ah-engine-vX.Y.Z-src.tar.gz` (sources plus `cargo vendor`). It then opens a PR that updates `ah-engine.lock`. The PR branch is named `ah-engine-prepare/vX.Y.Z-<run id>-<attempt>`, so a re-run does not collide with an earlier one. The `force` input rebuilds an unchanged fingerprint; use it for a re-run after the artifacts expired. PRs opened with the default `GITHUB_TOKEN` do not start other workflows: close and reopen the PR, or push to its branch with a personal token, to run its checks. The PR targets the `base` input, which defaults to `dev` and is rejected if it is `main` (main changes only through PRs from dev). The repo setting "Allow GitHub Actions to create and approve pull requests" must be on.
3. Merge the PR. The prepare branch can be deleted afterwards. The prepare run's source commit must stay reachable (merged into a branch) until publish, because publish fetches it to check the fingerprint; if it is gone, rerun prepare.
4. **Publish.** Push the tag `ah-engine-vX.Y.Z` on the merged commit. The workflow fails unless the tagged commit is on the default branch, `ah-engine.lock` exists, its version equals the tag and `Cargo.toml`, its fingerprint equals the source's, the prepare run was a successful manual run whose source commit has the same fingerprint, the asset names are exactly the `targets.json` triples plus the source tarball for that version, and the prepare run's artifacts match every sha256 in the lock. The release job checks the sums again before creating the release. It then runs build-provenance attestation and creates the GitHub Release with every archive, its `.sha256`, and `SHA256SUMS`. Prepare artifacts expire after the repository's retention period; rerun prepare if they have.

## `ah-engine.lock`

JSON, one object:

| Field | Meaning |
|---|---|
| `schema` | Lock format version, currently `1`. |
| `version` | Engine version (`ah-engine/Cargo.toml`). |
| `tag` | `ah-engine-v<version>`. |
| `fingerprint` | Output of `fingerprint.sh` for the source in the same commit. |
| `prepare_run` | GitHub Actions run id of the prepare run holding the artifacts. Absent in the local example. |
| `assets` | Map of asset file name to sha256, for every release archive. |

`SHA256SUMS` is the `assets` map rendered as `<sha256>  <name>` lines.

## Installing the engine on user machines

The plugin installs only `plugins/anti-hall`, so the prepare PR also commits a byte-identical copy of the lock at `plugins/anti-hall/ah-engine.lock` (the publish job fails when the two differ). On every SessionStart, `hooks/ah-hook.sh` starts `hooks/ah-engine-bootstrap.sh` detached (skipped when the lock is absent or `AH_ENGINE_BIN` is set). The script detects the target (macOS arm64/x86_64, Linux x86_64/arm64 on glibc or musl, WSL2 as Linux), downloads `ah-engine-vX.Y.Z-<triple>.tar.gz` from the GitHub Release over HTTPS, and installs it to `~/.anti-hall/ah-engine/bin/ah-engine` only if its sha256 equals the lock's entry; a mismatch is refused (no trust on first use). The install is atomic and keeps the previous binary as `ah-engine.prev`. It never fails a session: any problem (offline, unsupported platform, mismatch, binary that does not run) is written to `~/.anti-hall/ah-engine/bootstrap.log` and the Node hooks stay in use. A failed attempt for a lock is retried after 6 hours. A binary the script did not install is never overwritten. The setting `engine.bootstrap` = false (or `AH_ENGINE_BOOTSTRAP=0`, which overrides it) opts out. Tests: `ah-engine/tests/bootstrap.sh` (local HTTP server, isolated HOME).

## Building from source

```sh
cd ah-engine
scripts/build.sh                      # host target
scripts/build.sh --target aarch64-unknown-linux-musl
```

This runs `cargo build --release --locked --target <triple>` and prints the path (`ah-engine/target/<triple>/release/ah-engine`) and its sha256. From the vendored source tarball, offline:

```sh
tar xzf ah-engine-vX.Y.Z-src.tar.gz && cd ah-engine-vX.Y.Z-src
cargo build --release --offline --frozen
```

## Verifying release artifacts

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum -c --ignore-missing SHA256SUMS       # Linux
gh attestation verify ah-engine-vX.Y.Z-<triple>.tar.gz --repo talas9/anti-hall
```

Run both in the directory holding the downloaded assets. `--ignore-missing` skips the listed assets you did not download.
