# Runbook: bump the Circuits engine / durable-streams images

## When to use

When the pgxsinkit fork of `electric-circuits` lands a change the repo needs, or durable-streams ships a
release worth moving to. Both are pinned, and both compose stacks must agree.

## Where the pins are

Four lines, two per image:

| Image                                                        | Harness                                       | Board                                        |
| ------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------- |
| `ghcr.io/pgxsinkit/electric-circuits/engine:sha-<short>`     | `infra/compose/docker-compose.yml` → `engine` | `infra/compose/board-compose.yml` → `engine` |
| `docker.io/electricax/durable-streams-server-rust:<version>` | `infra/compose/docker-compose.yml` → `ds`     | `infra/compose/board-compose.yml` → `ds`     |

There is no pin file and no bump script — edit the four lines by hand. (The engine pin is the `default`
half of a `${PGXSINKIT_CIRCUITS_ENGINE_IMAGE:-…}` substitution; keep it that way.)

## Where the engine images come from

The fork's own `docker.yml` builds `docker/Dockerfile.engine` on **every push to its `main`** and
publishes two tags: `main` and `sha-<short>`.

**Pin by `sha-<short>`, never `main`.** `main` moves whenever the fork moves, which would silently change
the engine under a lane or the board — a class of failure that reads as a flaky test rather than a
version change.

## Overriding without a bump

Both stacks read `PGXSINKIT_CIRCUITS_ENGINE_IMAGE`, so a local engine build needs no edit here:

```bash
podman build -f docker/Dockerfile.engine -t localhost/electric-circuits-engine:dev .   # in the fork
export PGXSINKIT_CIRCUITS_ENGINE_IMAGE=localhost/electric-circuits-engine:dev
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
an engine bump is a genuine incompatibility. Stop and report it; do not quietly pin back down.

Commit the four pin lines together, and say in the message which fork commit the `sha-` tag names.
