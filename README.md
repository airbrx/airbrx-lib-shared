# @airbrx/airbrx-lib-shared

Shared storage/logging toolkit, extracted from three independently-drifted vendored
copies (`airbrx-gateway`, `airbrx-api`, `airbrx-log-summary`) as the Cluster A
spike for [AIR-1409](https://linear.app/airbrx/issue/AIR-1409).

Public repo: nothing in this package is Airbrx-proprietary. It's pure infrastructure
plumbing (storage backends, logging, env detection) — the rules engine, cache-key
construction, and adapters stay in `airbrx-gateway`.

**This is a spike extraction, not a full reconciliation.** v1 proves the
extraction mechanics work end-to-end on the lowest-risk consumer
(`airbrx-log-summary`). It does not merge every behavioral difference between
the three original copies — see the baseline table below for what was
deliberately deferred.

## Per-file baseline (v1)

Every file in `lib/` is `airbrx-log-summary`'s own copy, ported verbatim, with
one exception noted below. This keeps `airbrx-log-summary`'s behavior
byte-identical after migration — no new capabilities were silently granted to
it, and no existing capability from gateway/api was silently merged in.

| File | Source | Notes |
|---|---|---|
| `DateTimeUtils.js` | log-summary, verbatim | **Not actually identical across all 3** (correcting the original ticket's headline claim): gateway adds a public `static toFilenameSafe(isoString)` method and refactors `nowForFilename()` to call it; api/log-summary lack it. Harmless for the log-summary pilot (nothing here calls it), but gateway's migration must not silently lose this method — port it forward then, not now. |
| `EnvironmentDetector.js` | log-summary, verbatim | log-summary's copy is the most advanced of the three (ECS/Fargate + Kubernetes + cgroup v2 detection, which gateway/api lack). Gateway's `SKIP_DOTENV` override was **not** ported forward — that's a Phase 2 decision when gateway migrates, not something to bolt onto log-summary's untested path. |
| `WinstonLogger.js` | log-summary, verbatim | All three copies have diverged in genuinely different directions: gateway adds tenant-aware child loggers + configurable log retention (`AIRBRX_LOG_MAX_SIZE`/`AIRBRX_LOG_MAX_FILES`); api adds `AIR-1333` request-context/scalar-splat formatting; log-summary has smarter `enableDisk` defaulting via `EnvironmentDetector`. None is a superset — deferred to Phase 2. |
| `StorageFactory.js` | log-summary, **minus one line** | Dropped a stray `console.error('[StorageFactory] Module not found error:', ...)` debug line present only in log-summary's copy — confirmed accidental cruft (gateway/api never had it), not a behavior change worth preserving. |
| `FilesystemStorage.js` | log-summary, verbatim | |
| `S3expressStorage.js` | log-summary, verbatim | |
| `S3Storage.js` | log-summary, verbatim — **kept standalone, no base class** | log-summary's `S3Storage` has never extended anything. Gateway's `Storage.js` base class (`presign()`, `readStream()`, path-escape protection `AIR-803`, missing-bucket alerting `AIR-2005`) and api's (`stat()`, content-type contract `AIR-1717`/`AIR-1977`) are both genuinely-evolved, non-overlapping feature sets — neither is a superset of the other. Introducing either into log-summary now would grant it capabilities it's never had and never tested. **Deliberately deferred to Phase 2**, when gateway and/or api actually migrate and a real product decision can be made about which capabilities the unified base class carries forward. |

**Not in v1 at all:**
- `Storage.js` (base class) — see `S3Storage.js` note above.
- `RequestContext.js` — only exists in gateway/api, not log-summary (the pilot), so it's out of scope for proving mechanics on the lowest-risk consumer. Revisit when gateway/api migrate.

## Usage

```js
const { StorageFactory } = require('@airbrx/airbrx-lib-shared');

const storage = StorageFactory.create({
  storage: { type: 'filesystem', basePath: './data' }
});
```

## Distribution (spike)

Consumed via git dependency, pinned to a commit SHA — not a private npm
registry. The repo is **public**: nothing in it is Airbrx-proprietary (see
above), and going public removes the CI credential-wiring problem entirely —
`npm ci` clones an unauthenticated public URL, identical on every target
(laptop, Lambda CI, Docker/Fargate build), with no SSH key or token to manage
anywhere. See AIR-1409 for the full reasoning.
