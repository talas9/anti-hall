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

`fingerprint.sh` prints the sha256 of a listing of per-file sha256 hashes, sorted by path. Inputs (relative to `ah-engine/`): `src/`, `rules.json`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `defaults/`, `targets.json`, `scripts/build.sh`, `scripts/package.sh`. Absent paths are skipped. Tests, docs, the README and CI workflows are not inputs. The result does not depend on mtimes, checkout path or OS.

## Procedure

1. Change the engine and bump `version` in `ah-engine/Cargo.toml`. Prepare skips the build when the fingerprint equals the one in `ah-engine.lock`.
2. **Prepare.** Run the `ah-engine-release` workflow (workflow_dispatch) on the release branch. For each entry in `targets.json` it builds with `cargo build --release --locked`, runs `cargo test --release --locked`, and packages `ah-engine-vX.Y.Z-<triple>.tar.gz` (binary, LICENSE, README under one top-level directory). It also builds `ah-engine-vX.Y.Z-src.tar.gz` (sources plus `cargo vendor`). It then opens a PR that updates `ah-engine.lock`. The `force` input rebuilds an unchanged fingerprint. The repo setting "Allow GitHub Actions to create and approve pull requests" must be on.
3. Merge the PR.
4. **Publish.** Push the tag `ah-engine-vX.Y.Z` on the merged commit. The workflow fails unless `ah-engine.lock` exists, its version equals the tag and `Cargo.toml`, its fingerprint equals the source's, and the prepare run's artifacts match every sha256 in the lock. It then runs build-provenance attestation and creates the GitHub Release with every archive, its `.sha256`, and `SHA256SUMS`. Prepare artifacts expire after the repository's retention period; rerun prepare if they have.

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
shasum -a 256 -c SHA256SUMS
gh attestation verify ah-engine-vX.Y.Z-<triple>.tar.gz --repo talas9/anti-hall
```

Run both in the directory holding the downloaded assets.
