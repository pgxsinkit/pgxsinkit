# @pgxsinkit/server

The [pgxsinkit](https://pgxsinkit.github.io) write API and secured read ingress:
`createSyncServer` owns the single mutation route and the registry-governed Electric
shape proxy, both behind one verified-claims adapter, plus the in-database
apply-function builder.

```bash
bun add @pgxsinkit/server @pgxsinkit/contracts
```

See the [documentation](https://pgxsinkit.github.io) for the write path and proxy.
