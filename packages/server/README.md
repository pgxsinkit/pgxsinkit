# @pgxsinkit/server

The [pgxsinkit](https://pgxsinkit.github.io) write API and secured read ingress:
`createSyncServer` owns the single mutation route and the read path's control plane
(`/sync/v1/subscribe`, `/sync/v1/refresh`, `/sync/v1/barrier`), both behind one
verified-claims adapter, plus `createStreamGate` — the stream edge that verifies a
stream token and proxies durable-streams bytes — and the in-database apply-function
builder.

```bash
bun add @pgxsinkit/server @pgxsinkit/contracts
```

See the [documentation](https://pgxsinkit.github.io) for the write path, the control
plane, and the edge.
