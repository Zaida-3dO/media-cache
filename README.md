# media-cache

A long-term, read-through cache of [Vercel Blob](https://vercel.com/docs/vercel-blob) objects,
keyed by the Blob **pathname**. Uploads still go straight to Vercel. Downloads you don't want billed
against your Blob transfer (admin panels, dev servers, previews, test runs) go through this service
instead: served from disk if held, otherwise fetched from the store **once**, stored, and served.
Blob paths are immutable, so files are kept forever and nothing is ever invalidated.

No npm dependencies (Node 22+ built-ins). It is meant to run on a trusted network, not on the open
internet.

## Endpoints

| Request | Behaviour |
|---|---|
| `GET/HEAD /<pathname>` | Hit: served from disk (`Content-Type`, `Content-Length`, `ETag`, `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges`). Miss: whole object fetched once from `${UPSTREAM_ORIGIN}/<pathname>`, written atomically, then served. Concurrent misses share one fetch. Range requests (206/416) are always answered from disk; ranges are never forwarded upstream. |
| upstream 4xx | Every upstream 4xx is passed through with its own status and never stored. Only 403 and 404 are remembered for `NEGATIVE_TTL_SECONDS` (60), so a missing object is not re-fetched on every request; other 4xx are asked again each time. Any other upstream failure (5xx, redirects, network errors) gives 502. |
| `GET /_health` | `{"ok":true}` |
| `GET /_stats` | (`Authorization: Bearer $STATS_TOKEN` if one is set; open otherwise) files, bytes, hits, upstream fetches, passthroughs, negative-cache hits, errors, `lastError` |
| `POST /_prewarm` | `Authorization: Bearer $PREWARM_TOKEN`, body `{"paths":[...]}` (max 10000). Disabled (404) if no token is set. |

A "hit" is a request answered from disk without an upstream fetch; the request that triggered a fetch counts under `upstreamFetches` instead.

## Config (env)

| Var | Default | |
|---|---|---|
| `UPSTREAM_ORIGIN` | **required** | your store's public base URL, e.g. `https://<store-id>.public.blob.vercel-storage.com`. The ONLY host ever contacted; redirects are never followed. The service refuses to start without it. |
| `PORT` | 8080 | |
| `DATA_DIR` | `/data` | objects at `$DATA_DIR/<pathname>`; index + temp in `$DATA_DIR/.cache-meta/` |
| `CORS_ORIGINS` | `http://localhost:*,http://127.0.0.1:*` | comma-separated; `host:*` = any numeric port, `*` = any origin. Add the origin of any site that reads media through the cache with CORS. |
| `PREWARM_TOKEN` | unset | enables `/_prewarm` |
| `STATS_TOKEN` | unset | when set, `/_stats` requires it as a Bearer token (`/_health` stays open) |
| `NEGATIVE_TTL_SECONDS` | 60 | |
| `MAX_OBJECT_BYTES` | 2 GiB | larger objects are refused (413) |
| `MAX_CACHE_BYTES` | 0 (unlimited) | when set, new objects are refused (507) once full; nothing is evicted |
| `UPSTREAM_TIMEOUT_SECONDS` | 600 | |
| `INDEX_FLUSH_SECONDS` | 30 | how often hit counters are written back to the index |

Logs are JSON lines on stdout (a startup config error goes to stderr). Objects stream to disk; memory use does not grow with object size.
If `x` is cached and `x/y.jpg` is later requested (or vice versa) the second answers 409: a file and a directory cannot share a name on disk.
Pathnames that are empty, contain `..`/`.`/empty segments, NUL/control characters, backslashes, or start with `.`/`_` are rejected with 400.

## Run

```
docker run -d --name media-cache -p 8080:8080 -v "$PWD/data:/data" \
  -e UPSTREAM_ORIGIN=https://<store-id>.public.blob.vercel-storage.com \
  ghcr.io/zaida-3do/media-cache:latest
```

Images (`linux/amd64`, `linux/arm64`) are published by CI: `latest` is the tip of `main`, and every
build is also tagged `sha-<commit>`. To build it yourself: `docker build -t media-cache .`. Without
Docker: `UPSTREAM_ORIGIN=... DATA_DIR=./data node src/main.mjs`.

Then point your non-public clients at the cache: `https://<store-id>.public.blob.vercel-storage.com/<pathname>`
becomes `http://<cache-host>:8080/<pathname>`.

## Tests

```
node --test test/*.test.mjs
```

Runs against a local fake upstream; no network and no Vercel needed.

## Pre-warm (a full copy of the store doubles as a media backup)

```
vercel blob list ... | <extract pathnames> > paths.txt
PREWARM_TOKEN=... node src/prewarm-cli.mjs http://<cache-host>:8080 paths.txt
```
