# Runbook: bump the Circuits engine / durable-streams images

## When to use

When [pgxsinkit/circuits](https://github.com/pgxsinkit/circuits) lands a change this repository needs.
Both images are pinned, and both compose stacks must agree.

## Where the pins are

Four lines, two per image, all carrying **the same tag**:

| Image                                              | Harness                                       | Board                                        |
| -------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `ghcr.io/pgxsinkit/circuits/engine:<tag>`          | `infra/compose/docker-compose.yml` → `engine` | `infra/compose/board-compose.yml` → `engine` |
| `ghcr.io/pgxsinkit/circuits/durable-streams:<tag>` | `infra/compose/docker-compose.yml` → `ds`     | `infra/compose/board-compose.yml` → `ds`     |

There is no pin file and no bump script — edit the four lines by hand. (Each pin is the `default` half of a
`${PGXSINKIT_CIRCUITS_ENGINE_IMAGE:-…}` / `${PGXSINKIT_DS_IMAGE:-…}` substitution; keep it that way.)

## Where the images come from

The engine and the log server are one repository. Its `images.yml` workflow builds both from one commit
and publishes them under the same tags, after the repository's validation has passed:

| Trigger               | Tags                                 |
| --------------------- | ------------------------------------ |
| push to its `develop` | `sha-<short>`, `dev`                 |
| a semver tag          | `<version>`, `latest`, `sha-<short>` |

**Pin by `sha-<short>` or by version, never `dev` or `latest`.** Those two move whenever that
repository moves, which would silently change the image under a lane or the board — a class of failure
that reads as a flaky test rather than a version change.

The engine is tested there against the log server of the same commit, so the pair is only known to work
together **at one tag**. Do not mix tags.

## Overriding without a bump

Both stacks read `PGXSINKIT_CIRCUITS_ENGINE_IMAGE` and `PGXSINKIT_DS_IMAGE`, so a local build needs no
edit here. In a checkout of pgxsinkit/circuits:

```bash
podman build -f container/Containerfile.engine -t localhost/circuits-engine:dev .
export PGXSINKIT_CIRCUITS_ENGINE_IMAGE=localhost/circuits-engine:dev
podman build -f container/Containerfile.durable-streams -t localhost/circuits-durable-streams:dev .
export PGXSINKIT_DS_IMAGE=localhost/circuits-durable-streams:dev
```

Shell env wins over an `--env-file` value, so `export` works for the board stack too. The commented
defaults live in `.env.example` (harness) and `infra/compose/board.env` (board), both under the
Circuits section. Use the
override to iterate; land a `sha-` pin to make it the repo's version.

## After the bump

Run the container lanes — they are the only wire-compatibility proof:

```bash
bun run test:integration
```

A failure in the read-path lanes (`asymmetric-read`, `membership-fanout`, `registry-sync-roundtrip`) after
an engine or durable-streams bump is a genuine incompatibility. Stop and report it; do not quietly pin back down.

Commit the four pin lines together, and say in the message which commit of pgxsinkit/circuits the tag names.
