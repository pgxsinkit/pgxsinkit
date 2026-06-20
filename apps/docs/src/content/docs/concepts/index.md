---
title: Core concepts
description: The pgxsinkit mental model in six short pages.
sidebar:
  order: 1
  label: Overview
---

These six pages are the mental model. Read them in order — each builds on the last, and together
they cover everything a fresh reader (human or AI) tends to get wrong.

1. [The two paths](/concepts/two-paths/) — read and write are separate and asymmetric.
2. [The write path](/concepts/write-path/) — stage locally, flush a batch, apply in the database.
3. [The read path](/concepts/read-path/) — shapes stream Postgres → Electric → PGlite, via a proxy.
4. [The Electric subquery requirement](/concepts/electric-subqueries/) — the mandatory flag, and
   why it fails closed.
5. [Timestamps](/concepts/timestamps/) — microsecond integers carried as decimal strings.
6. [Local schema & DDL parity](/concepts/local-schema-ddl-parity/) — what local PGlite does and
   does not replicate.

The canonical vocabulary for all of these lives in the repository's `CONTEXT.md`.
