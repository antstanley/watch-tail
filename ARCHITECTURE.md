# watch-tail architecture

`watch-tail` tails Amazon CloudWatch Logs and streams them into a local web UI.

```
Browser (SvelteKit client)
  |  fetch /api/log-groups      -> group list for a region
  |  EventSource /api/stream    -> live log events (SSE)
  v
SvelteKit server routes (Node, TypeScript)
  |  @aws-sdk/client-cloudwatch-logs  (DescribeLogGroups + FilterLogEvents polling)
  v
CloudWatch Logs API  --- ambient AWS credentials
  or floci on http://localhost:4566 (when AWS_ENDPOINT_URL is set)

Local history (optional, `source=archive`):
  every streamed batch is appended to archive.duckdb through @duckdb/node-api,
  and the UI can read the same file back without credentials:
  Browser -- EventSource /api/stream?source=archive --> DuckDB file
```

## Layout

| Path                                          | Purpose                                                              |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `src/lib/types.ts`                            | Wire types shared by server routes and UI                            |
| `src/lib/regions.ts`                          | Canonical region list shared by server and browser                   |
| `src/lib/server/env.ts`                       | Effective env: `$env/dynamic/private` + `process.env` + `.env.local` |
| `src/lib/server/aws.ts`                       | Region/endpoint resolution, CloudWatch Logs client factory           |
| `src/lib/server/regions.ts`                   | Region list for the picker                                           |
| `src/lib/server/log-groups.ts`                | `DescribeLogGroups` pagination                                       |
| `src/lib/server/tail.ts`                      | Polling tail engine: cursor, de-duplication, backoff, abort          |
| `src/lib/server/archive.ts`                   | Local DuckDB archive: lazy driver, writes, reads, degradation        |
| `src/lib/server/archive-sql.ts`               | Archive schema, statements and row mapping (no driver import)        |
| `src/lib/server/archive-tail.ts`              | Replays the archive as the same batches the tailer yields            |
| `src/lib/server/source.ts`                    | The `source` parameter shared by both list and stream endpoints      |
| `src/lib/server/level-filter.ts`              | The `level` parameter, and tagging live events with their level      |
| `src/lib/server/filter.ts`                    | Duration parsing (`5m`, `2h`, epoch ms, ISO 8601)                    |
| `src/lib/server/sse.ts`                       | Server-sent event framing                                            |
| `src/routes/api/*`                            | JSON + SSE endpoints                                                 |
| `src/routes/api/archive/+server.ts`           | `GET /api/archive`: what the local archive holds                     |
| `src/routes/api/series/+server.ts`            | `GET /api/series`: bucketed counts behind the chart                  |
| `src/lib/server/multi-tail.ts`                | Merges one tail per group into the single stream the UI reads        |
| `src/lib/server/group-params.ts`              | The `group`/`groups` selection shared by the list, stream and series |
| `src/lib/components/*`                        | UI building blocks                                                   |
| `src/lib/log-buffer.ts`                       | Client-side ring buffer, text filter and level detection             |
| `src/lib/series-buckets.ts`                   | Client-side bucketing and level palettes for the chart               |
| `src/lib/components/EventScatter.svelte`      | The scatter chart itself: the only importer of layerchart            |
| `src/lib/components/EventScatterPanel.svelte` | Chart header, collapse toggle and the on-demand chart load           |
| `src/lib/log-format.ts`                       | JSON detection, pretty-printing and tokenizing                       |
| `src/lib/resize.ts`                           | Pure resize math and `localStorage` preference keys                  |
| `src/lib/time-range.ts`                       | Presets, window formatting and datetime-local conversions            |
| `src/lib/components/ColumnResizer.svelte`     | Focusable drag handle for both resizable columns                     |
| `src/lib/components/RangeControls.svelte`     | Live/Historic toggle, preset chips and custom window                 |
| `scripts/floci-env.ts`                        | Write/remove `.env.local` for the floci emulator                     |
| `scripts/seed-floci.ts`                       | Demo log groups, backfill and live traffic                           |
| `scripts/dev.ts`                              | Launcher: choose an AWS profile (`--profile`) or run local           |
| `scripts/ui-smoke.ts`                         | Playwright smoke check of the log window                             |
| `src/cli/mcp/run.ts`                          | `watch-tail mcp` lifecycle and `mcp init` orchestration              |
| `src/cli/mcp/tools.ts`                        | MCP tool catalogue, valibot schemas and request mapping              |
| `src/cli/mcp/backend.ts`                      | HTTP client and SSE reader behind the MCP tools                      |
| `src/cli/mcp/stdio.ts`                        | Newline JSON-RPC loop that drives tmcp's server                      |
| `src/cli/mcp/agents.ts`                       | Agent registry, detection and config merging                         |

## HTTP API

### `GET /api/health`

```json
{
	"ok": true,
	"region": "us-east-1",
	"endpoint": "http://localhost:4566",
	"local": true,
	"credentials": "ambient"
}
```

`credentials` is `emulator-default` when the endpoint is a local emulator and no credential
variables are configured at all (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`,
`AWS_CONFIG_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, the container-credential variables and
`AWS_ROLE_ARN` are all unset). In that case the client is built with `EMULATOR_CREDENTIALS`
(`test`/`test`) - floci and LocalStack accept any non-empty key pair and still sign requests, and
this branch can never run for a non-local endpoint. Any one of those variables being set keeps the
untouched SDK provider chain (`credentials: "ambient"`).

### `GET /api/regions`

```json
{
	"regions": ["us-west-1", "us-east-1", "us-west-2"],
	"defaultRegion": "us-west-1",
	"endpoint": null
}
```

`defaultRegion` is the region the server will use when a request does not name one, and it is
prepended to `regions` when `WATCH_TAIL_REGIONS` does not include it, so the picker can show one
entry more than the configured list.

The default list is `REGION_CODES` in `src/lib/regions.ts`: every region in the standard `aws`
partition that publishes a CloudWatch Logs endpoint (derived from the AWS CLI's
`botocore/data/endpoints.json`), including `af-south-1`. China, GovCloud and the ISO partitions are
excluded; set `WATCH_TAIL_REGIONS` to override the list entirely.

### `GET /api/identity?region=<region>`

Calls `sts:GetCallerIdentity` with the same resolved configuration, so a 200 means the ambient
credentials work at all and the ARN says whose they are. The CLI uses it before offering any login.

```json
{
	"arn": "arn:aws:sts::111111111111:assumed-role/Administrator/me",
	"account": "111111111111",
	"userId": "AROAEXAMPLE:me",
	"region": "af-south-1",
	"endpoint": null
}
```

### `GET /api/log-groups?region=<region>&prefix=<prefix>&limit=<n>&source=<source>`

`region` is optional: without it the request uses the server's effective region (see
[Region resolution](#region-resolution)). `source` accepts `cloudwatch` (the default) or `archive`;
the archive form is described under [Reading the archive](#reading-the-archive-sourcearchive).

```json
{
	"region": "us-east-1",
	"endpoint": null,
	"source": "cloudwatch",
	"groups": [{ "name": "/aws/lambda/checkout", "arn": "arn:...", "storedBytes": 1024 }]
}
```

Errors use `ApiErrorBody`: `{ "error": "...", "code": "...", "details": "..." }` with a
4xx status for bad input and 502 for upstream CloudWatch failures.

### `GET /api/stream` (Server-Sent Events)

Query parameters:

| Name            | Required | Meaning                                                                |
| --------------- | -------- | ---------------------------------------------------------------------- |
| `region`        | no       | AWS region to query; defaults to the effective region                  |
| `group`         | yes      | Log group name                                                         |
| `mode`          | no       | `live` (default) tails new events; `historic` scans a fixed window     |
| `range`         | no       | Historic preset: `15m`, `1h`, `3h`, `12h`, `24h`, `5d` (default `15m`) |
| `from` / `to`   | no       | Custom historic window: epoch ms or ISO 8601 (`from` takes `15m`)      |
| `filterPattern` | no       | CloudWatch filter pattern passed to `FilterLogEvents`                  |
| `startTime`     | no       | Start point: epoch ms, ISO 8601, or duration (`15m`, `2h`)             |
| `lookback`      | no       | Duration used when `startTime` is absent (default `5m`)                |
| `poll`          | no       | Poll interval in ms, clamped to 250..15000 (default 1000)              |
| `source`        | no       | `cloudwatch` (default) or `archive`; see the archive section below     |
| `search`        | no       | Archive only: case-insensitive substring match on the message          |
| `pageSize`      | no       | Archive only: events per read, 1..5000 (default 1000)                  |
| `max`           | no       | Archive only: event cap for the request, 1..100000 (default 10000)     |
| `level`         | no       | Archive only: `error`, `warn`, `info`, `debug`, comma separated        |

A historic request sets `endTime` on every `FilterLogEvents` call and ends by itself: with
`window-complete` once the window is exhausted (two empty polls, since ingestion can lag), with
`event-limit` after 10 000 events, or with `repeated-errors` after eight failed polls. Live requests
never end on their own - only a disconnected client stops them (`client-disconnected`).

A historic `source=cloudwatch` request first reads whatever the archive already holds and only scans
CloudWatch for the gaps (see [Historic CloudWatch views read the archive first](#historic-cloudwatch-views-read-the-archive-first));
a `filterPattern` keeps the request entirely on CloudWatch.

Events:

| SSE event | Payload                                         |
| --------- | ----------------------------------------------- |
| `ready`   | `{ region, logGroupName, endpoint, startTime }` |
| `log`     | `{ events: LogEventDto[] }`                     |
| `ping`    | `{ at: number }` (sent every 15 s of silence)   |
| `error`   | `{ message, code? }`                            |
| `end`     | `{ reason }`                                    |

The stream stops when the browser disconnects (`request.signal` aborts).

The `ready` payload also carries `source`, so a client always knows which feed it is reading.

### Stopping a streaming server

A live tail is a connection that never finishes on its own, and adapter-node shuts down gracefully: on
`SIGINT`/`SIGTERM` it stops accepting connections and waits for the in-flight ones to close,
force-closing them only after `SHUTDOWN_TIMEOUT` (thirty seconds by default). With a browser attached,
that grace period is the whole delay - Ctrl+C looked like it did nothing for half a minute.

Every SSE response therefore registers itself in `src/lib/server/live-streams.ts` when it starts and
unregisters when it ends. A signal closes them all at once, and each one writes an `end` frame with
`reason: server-stopping` before closing, so the browser is told why the stream ended instead of seeing a
dead socket. The graceful shutdown then completes in the same tick. The CLI (`src/cli/server.ts`) and the
dev launcher also pass a two-second `SHUTDOWN_TIMEOUT` as an outer bound for anything else that is still
connected. `tests/shutdown.spec.ts` runs the built server with a live tail attached and asserts that it
exits promptly, which is the regression this exists to prevent.

## Reading the archive (`source=archive`)

`GET /api/stream?source=archive&region=<region>&group=<group>` replays events from the local DuckDB
archive instead of calling CloudWatch Logs. It needs **no credentials and no client**: the route
resolves the region from the `region` parameter (`AWS_REGION`/`AWS_DEFAULT_REGION` also count) and
refuses the request with code `missing-region-param` when there is none, because archived rows are
stored per region.

- The archive has no live mode. `mode` defaults to `historic`; an explicit `mode=live` is rejected with
  `invalid-mode`.
- `range`, `from` and `to` are the same windows as for CloudWatch, without the 14-day clamp.
- `search` is a case-insensitive substring match on the archived message, with `%` and `_` escaped. It
  is **not** a CloudWatch filter pattern; `filterPattern` is ignored for this source.
- `level` keeps only rows whose stored level is one of the levels asked for. Rows stored as `NULL`
  (nothing was detected) are left out, because asking for `error` is a request for known errors.
  `level` is rejected on `source=cloudwatch` with code `invalid-level`: CloudWatch has no level field,
  so use `filterPattern` there. The UI filters levels client-side instead, which keeps one control
  working for both sources.
- Events are read in pages (keyset paging on `(timestamp_ms, seq)`, so equal timestamps cannot repeat
  or skip a row) and end with `window-complete` or `event-limit`, exactly like a historic CloudWatch
  scan. `pageSize` (default 1000, clamped to 1..5000) sets how many rows one statement reads and `max`
  (default 10 000, clamped to 1..100000) caps the request; an unparsable value falls back to the
  default instead of failing the stream.
- An archive that is off (`WATCH_TAIL_ARCHIVE=off`), missing its driver or locked by another process
  streams a single `error` frame with code `archive-unavailable` and then `end`.

`GET /api/log-groups?source=archive&region=<region>` lists what the archive holds for that region
without contacting AWS. Each group carries `archivedEvents`, `archivedOldest` and `archivedNewest`;
`endpoint` is `null` and `source` is `archive`.

### Historic CloudWatch views read the archive first

The archive is not only a separate `source`: a **historic** view on `source=cloudwatch` (the
default) answers from the archive wherever it already holds the window, and only calls AWS for the
gaps. The archive holds only what was streamed, so the boundary is not a single watermark - a
watermark would skip the periods watch-tail was not running - but the **coverage** recorded in
`archive_coverage`: the ranges watch-tail can prove it queried and archived for a group.

- A scan records coverage only when it can be trusted: a completed, **unfiltered** CloudWatch scan.
  A `filterPattern` archives a subset of a range, so it is never recorded, and a live tail records
  each poll that succeeded (via `onPoll` in `tail.ts`) rather than the whole session.
- On a request, `resolveHybridFeed` intersects the window with each group's coverage: covered ranges
  are replayed with `tailArchivedEvents`, and the remaining ranges are fetched with `tailLogEvents`
  and merged by `mergeTails`. A window with no coverage behaves exactly as before (one CloudWatch
  scan); a fully covered window never constructs a CloudWatch request at all.
- Replayed rows carry `origin: 'archive'` on their batch, so the pump archives only CloudWatch
  events and never writes archived rows back.
- When the scan finishes its window, the ranges it read from CloudWatch are recorded as coverage, so
  the next view of that window is answered entirely from the archive.

Windows and coverage are clipped to CloudWatch's 14 days, because the gaps are still fetched from
AWS; the archive can hold ranges older than that, so `source=archive` remains the way to read beyond
the CloudWatch retention limit.

### `GET /api/archive`

Reports the file, its size and its contents. This endpoint never fails: an archive that is off, broken
or locked answers `200` with `available: false` and the reason, so the UI can hide the archive view
instead of showing an error.

```json
{
	"path": "/home/you/.local/share/watch-tail/123456789012/eu-west-1/archive.duckdb",
	"available": true,
	"error": null,
	"bytes": 4096,
	"rows": 12,
	"groups": 3,
	"regions": 2,
	"oldest": 1738368000000,
	"newest": 1738368180000
}
```

### Archive schema

One table holds every event the app has streamed, plus one unique index that makes a repeated scan
idempotent:

```sql
CREATE TABLE log_events (
	region            VARCHAR NOT NULL,
	log_group         VARCHAR NOT NULL,
	log_stream        VARCHAR,
	event_key         VARCHAR NOT NULL,   -- event id, or a hash of (timestamp, stream, message)
	event_id          VARCHAR,
	timestamp_ms      BIGINT  NOT NULL,
	ingestion_time_ms BIGINT,
	message           VARCHAR NOT NULL,
	level             VARCHAR,           -- error | warn | info | debug, or NULL
	level_source      VARCHAR,           -- 'json' when the payload declared it, 'text' when matched
	request_id        VARCHAR,           -- the request the line belongs to, or NULL
	seq               BIGINT  NOT NULL DEFAULT nextval('log_events_seq'),
	archived_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX log_events_unique ON log_events (region, log_group, event_key);
CREATE INDEX log_events_time ON log_events (region, log_group, timestamp_ms);
CREATE TABLE archive_meta (key VARCHAR PRIMARY KEY, value VARCHAR);
CREATE TABLE archive_coverage (
	region    VARCHAR NOT NULL,
	log_group VARCHAR NOT NULL,
	start_ms  BIGINT  NOT NULL,   -- inclusive
	end_ms    BIGINT  NOT NULL,   -- inclusive
);
```

`level` and `level_source` are the one inferred pair of columns. CloudWatch has no level field, so the
server detects it once, on the way in, with `detectLevelWithSource` in `src/lib/log-buffer.ts`:

- a level the payload declares (`level`, `severity`, `lvl`, `logLevel`, `log_level`) wins, because it is
  a statement of fact - `{"level":"info","msg":"retry after error count 0"}` is `info`, not `error`;
- otherwise the text heuristic runs, and `level_source` is `text`;
- otherwise both columns are `NULL`. "No level found" is deliberately not stored as `info`: a
  stack-trace continuation line has no severity, and the database should not claim it does.

Declared values are normalised onto `error | warn | info | debug` (`fatal`, `critical`, `panic` and
friends become `error`; `trace` and `verbose` become `debug`), and Bunyan/pino numbers 10/20/30/40/50/60
are mapped too. An unknown number - `{"level":0}` means different things in different loggers - is not
guessed at; it falls through to the text heuristic.

The same detection runs for a live stream, so the `level` the UI colours and the `level` the database
stores cannot drift apart, and an event replayed from the archive keeps the level that was stored
rather than being guessed again.

`request_id` is the other inferred column, detected with `detectRequestId` in the same module: a declared
request id wins (see [Requests](#requests-one-mark-per-request)), and the text form `RequestId: ...` is
the fallback, because that is how a Lambda prints it. `NULL` means "this line carries no request id",
which is the normal case for an access log or a database log.

Writes go through `INSERT OR IGNORE` in chunks of 500 rows, so re-scanning a window that is already
archived changes nothing. A file written before these columns existed is migrated in place with
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; its older rows keep `NULL` levels, and their request ids
are filled in by the backfill below.

#### The request-id backfill

A file written before `request_id` existed holds rows that were never looked at, and a row with no
request id is not the same claim as a row whose message has none. Since the detection lives in
JavaScript, the archive cannot do this in SQL, so it does it once, in a pass that is bounded and
resumable:

- `archive_meta` holds the watermark `request_id_backfill`: the highest `seq` that has been scanned.
  An absent watermark means "scan from the start".
- One pass reads at most `REQUEST_ID_BACKFILL_LIMIT` (20 000) candidate rows with
  `seq <= max(seq) AND request_id IS NULL ORDER BY seq`, detects their ids, and writes them back in one
  `UPDATE ... FROM (VALUES ...)` per chunk of 500.
- It then stores the highest `seq` it actually saw, so an archive larger than the budget finishes on
  the next open, and an interrupted pass resumes where it stopped.
- Rows whose message yields no request id stay `NULL` for ever, and are not rescanned: the watermark
  only moves forward. That is why the scan also takes a lower bound (`seq > watermark`), rather than
  being driven by `request_id IS NULL` alone - otherwise every pass would start on the same id-less
  rows and never reach the rows above them.

The pass runs once per open, inside the archive's existing write guard, and a failure is reported
through the same degradation path as any other archive error instead of failing the open. `seq` orders events by arrival and is what makes keyset paging stable when
thousands of events share a millisecond; `event_key` is the CloudWatch event id when there is one, and
a SHA-256 of timestamp, stream and message when there is not (floci and LocalStack omit ids), which
keeps those events de-duplicable too.

Writing costs roughly 15-23 ms per 500-row chunk (about 30-45 ms per 1000 events) with this schema, so
it stays well behind the polling loop; the fixed cost of binding 4000 parameters dominates, and
`INSERT OR IGNORE` is not meaningfully slower than a plain `INSERT`. The Appender API cannot be used
here at all, because `seq` has a `nextval()` default that the appender refuses to fill.

Each account/region archive is a DuckDB file with a single writer: the server process holds the lock, statements are
serialised through an internal queue, and a failure (a full disk, a locked file) is recorded and
reported by `/api/archive` rather than interrupting a stream.

Archive routing lives in `src/lib/server/archive-location.ts`. STS identifies the account before
new CloudWatch streams write. The default layout is `<data-dir>/watch-tail/<account>/<region>/archive.duckdb`;
custom endpoints add an `endpoints/<endpoint-hash>/` namespace. A map of opening promises keyed by
absolute file path prevents duplicate writers inside a process. All archive routes select the
requested region; `/api/archive?region=...` reports that file's status.

Verified account/region mappings are cached under `identities/`, keyed by a hash of credential-source
selectors and endpoint/region. They contain no credentials. Reads re-check STS and use cached
mappings only if lookup fails, so changing the account behind a profile refreshes archive selection.
Writes re-check STS and never fall back to a cached account after an identity failure. Failed lookups
are retried on subsequent requests. `WATCH_TAIL_ARCHIVE_DIR` overrides the root directory;
`WATCH_TAIL_ARCHIVE_DB` / `--db` selects one explicit file instead, including legacy archives.
Legacy files are not migrated because they do not contain account IDs.

## Headless MCP server

`watch-tail mcp` runs watch-tail as a local [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, so an agent can search CloudWatch and the archive without calling AWS itself.
The MCP process is a **thin client**: it starts the same built SvelteKit app the browser uses on a
free loopback port (or attaches to one with `--url`), then proxies the existing HTTP API. That keeps
`$lib`-aliased server modules out of the compiled CLI and leaves one implementation of every source,
filter and error mapping.

```
Agent -- stdio (newline JSON-RPC) --> watch-tail mcp
                                        |  spawns `node build/index.js` on a free port
                                        |  GET /api/archive, /api/log-groups, /api/identity
                                        |  GET /api/series
                                        |  GET /api/stream  (SSE, source=archive|cloudwatch)
                                        v
                                      watch-tail server --> DuckDB archive / CloudWatch Logs
```

The protocol is handled by [tmcp](https://tmcp.io), which owns revision negotiation, capabilities,
argument validation and result framing. `src/cli/mcp/tools.ts` only declares the tools and their
valibot schemas (converted to JSON Schema by `@tmcp/adapter-valibot`), and maps a call onto the
backend. Both protocol generations work: the session handshake (`2025-06-18` and earlier) and the
stateless `2026-07-28` revision, where the client names its revision and capabilities in each
request's `_meta`.

`src/cli/mcp/stdio.ts` is a deliberately small framing loop over `McpServer.receive` instead of
`@tmcp/transport-stdio`: the official transport calls `process.exit()` itself, which would tear the
process down before the private watch-tail server it proxies could be stopped gracefully. The loop
reserves stdout for the protocol; every diagnostic goes to stderr. It also narrows tmcp's
`initialize` result to the fields the protocol defines, because tmcp spreads the server options it
was built with into that one response (which leaks its `adapter` instance as `{}`).

`src/cli/mcp/run.ts` owns the lifetime: `runMcpServer` starts the private server (a free port from
`findFreePort`), waits for health, serves, and stops the server when stdin closes or a signal
arrives. `runMcpInit` detects installed agents, asks which to configure, and writes each one's
merge plan. Both take their side effects as arguments, so tests drive them without a process, a
terminal or a filesystem.

`src/cli/mcp/agents.ts` is the registry of configurable agents (Claude Desktop, Claude Code, Cursor,
Windsurf, VS Code, Gemini CLI, Codex CLI). Detection is "does this path or binary exist"; planning is
a pure merge of the current file text. JSON agents keep every other key and only set
`<serverKey>.watch-tail`; Codex's TOML has its `[mcp_servers.watch-tail]` section replaced or
appended. A file that cannot be parsed is reported, never overwritten. The written command defaults
to `npx -y watch-tail@<version> mcp`, so an upgraded package is picked up; `--command`/`--args` point
it at a local build instead.

## Several log groups, and the chart

A view can hold more than one log group. `group=a` and `groups=a,b,c` are both accepted by
`/api/stream`, `/api/log-groups` and `/api/series`; the list is de-duplicated, capped at 10 and parsed by
`src/lib/server/group-params.ts`. Every streamed event carries its own `group`, which is what labels the
group column in the viewer and what files each batch under the right group in the archive.

The two sources provide several groups differently:

| Source       | How several groups are read                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `archive`    | one SQL statement per page, `WHERE log_group IN (...)`                                                              |
| `cloudwatch` | one `FilterLogEvents` poll loop per group, merged by `mergeTails` so a busy group is never held back by a quiet one |

### Requests: one mark per request

CloudWatch Logs has no concept of a request, so the app infers one. `src/lib/request-groups.ts` is the
single place that decides what a request is, and both the log view and the chart call it:

- **Detection** (`detectRequestId`, next to the level detection in `src/lib/log-buffer.ts`): a declared
  payload key wins - `requestId`, `request_id`, `requestID`, `reqId`, `req_id`, `awsRequestId`,
  `aws_request_id`, `xRequestId`, `x_request_id`, `x-request-id`, `X-Request-Id` - then the text form
  `request id[:=] <value>` (any casing, `-`/`_`/space separators), which is the shape a Lambda prints:
  `START RequestId: 1a2b-... Version: $LATEST`. Values shorter than four characters and placeholders
  (`none`, `null`, `unknown`, `$LATEST`) are rejected. A **bare UUID is deliberately not** a request id:
  trace, session and file ids are not requests, and grouping by one would invent requests that never
  existed.
- **Grouping** (`collectRequests`, `requestRows`): lines that share an id are one group, wherever they
  appear in the buffer, across log groups as well as within one - which is what makes an API Gateway
  request and the Lambda invocation it triggered one request. Lines with no id are never grouped; each
  keeps its own row and its own mark.
- **Severity**: a group's level is the **most critical** line in it (`mostCriticalLevel` over
  `LEVEL_RANK`), so a request with one error among twenty info lines is an error.
- **Placement**: a request is marked where it **starts** (its first line). A request that logs across a
  bucket boundary is counted once, in the bucket it started in, not once per bucket it touches - which
  is why the chart's total can be lower than the number of lines.
- **The log view** collapses a group into one row (id, line count, span, most critical level, and the
  worst line as a preview), opened on demand. A group with a single line renders as that line, because
  there is nothing to expand. The toggle is the log view's **By request** button, on by default and
  stored under `watch-tail:group-requests`.
- **The chart** counts requests. The archive does it in SQL; a CloudWatch view does it in
  `bucketRequests`. Both count a line with no request id as a mark of its own
  (`coalesce(request_id, event_key)` in SQL), so nothing disappears when grouping is on. The level
  filter selects a **request** by that group's most critical level, which is the level the mark is drawn
  in, so the legend and the chips never disagree.

### The chart (`GET /api/series`, `EventScatterPanel` and `EventScatter`)

The scatter chart above the log view plots event counts over time: X is time, Y is the number of requests
in a bucket, and there is one series per log level. `by=request` (the default the UI sends) counts
requests; `by=event` counts lines, which is what the chart did before grouping existed. Dragging across it brushes a time range; the page
turns that into the next historic window, so the log view re-scopes to exactly the brushed range, and
`?from=&to=` in the URL follows. A click clears the brush, and the "Reset zoom" control clears it and
returns to the preset window.

Only the archive can count a whole window server-side, so the chart gets its data two ways:

- `source=archive` calls `GET /api/series?region=&groups=&from=&to=&level=&bucket=&by=`, which runs one
  `GROUP BY` over `log_events`. The bucket is integer arithmetic on `timestamp_ms`
  (`floor(timestamp_ms / bucketMs) * bucketMs`), so it never drifts with a time zone; NULL levels are
  counted as `unknown` rather than dropped; and the window is **not** clamped to CloudWatch's 14 days.
  `bucket` accepts a duration or milliseconds and is otherwise chosen from a ladder so a window lands
  under ~90 buckets. `by=request` selects the request form: a CTE groups rows by
  `coalesce(request_id, event_key)`, keeps `min(timestamp_ms)` as the mark's position and the `max` of
  the level ranks as its level, and the level filter is a `HAVING` on that rank.
- `source=cloudwatch` buckets the events the view has already streamed (`bucketEvents`), because
  CloudWatch Logs has no aggregate API. The chart then describes exactly what the log view holds.

Both paths produce `SeriesPoint[]`, so the component has one data contract, and the level filter is
applied in both: the archive query filters rows with `level IN (...)` (so `NULL` rows are left out), and
the client-side path filters before counting.

The tooltip is styled by the app rather than by layerchart. layerchart's own tooltip rules set
`background-color` and `color` from `--color-surface-100` / `--color-surface-300` /
`--color-surface-content`, and the only files that define those variables are its framework presets
(shadcn-svelte, Skeleton, daisyUI). This app imports none of them, so the variables stay unset and the
tooltip renders transparent with black text. `EventScatter` therefore passes explicit Tailwind classes
through layerchart's `classes.container`, and because layerchart's rules live in `@layer components`
while Tailwind emits `@layer utilities`, those utilities win. The colours are asserted in the browser
smoke run (`chart tooltip has a background`), which is the only place the property is observable.

The panel and the chart are two components on purpose. `EventScatterPanel` renders the header
(title, totals, per-level legend, brush hint) and owns a collapse toggle whose choice is stored under
`watch-tail:chart-open`; `EventScatter` imports layerchart and draws the chart. The panel fetches the
chart module with a **dynamic import** the first time it is open, so layerchart is never part of the
first load - measured on the production build, an open panel requests ~235 KiB of chart code after the
page has started and a collapsed one requests none. The loader is injectable (`loadChart`), which is how
the panel is tested without depending on the bundler. "Reset zoom" remounts the chart with `{#key}`,
which is what clears a brush without holding an imperative handle on a lazily loaded component.

Two layerchart 2.5 behaviours shape the chart: it must render only in the browser (its `ssr: true` path
overflows the stack, so the default is kept and the server sends only the wrapper, into which the chart
appears after hydration), and per-axis configuration belongs in `props={{ xAxis, yAxis }}` because an
`axis={{ x, y }}` object is silently ignored. The brush reports a domain pair of `Date`s, which the
component converts to epoch milliseconds, with a 30-second `minExtent` so a small drag cannot zoom to a
sliver.

## Region resolution

The region is resolved in this order:

1. the `region` query parameter (blank is treated as "not supplied"),
2. `AWS_REGION`, then `AWS_DEFAULT_REGION`,
3. the ambient AWS configuration the SDK reads itself: the active profile's `region`, then
   `[default]`'s region in `~/.aws/config`.

When none of these resolve, the client is created without a region and the SDK raises its own
error; that is mapped to code `missing-region` with the message
_"No AWS region is configured. Set AWS_REGION or add a region to your AWS profile."_
`FALLBACK_REGION` (`us-east-1`) is used only to display a region when resolution fails - it is
never sent to the SDK.

## Error codes

| Code                   | Status | Meaning                                                            |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| `invalid-region`       | 400    | `region` param is not a plausible region code                      |
| `invalid-limit`        | 400    | `limit` param is not an integer in 1..1000                         |
| `invalid-mode`         | 400    | `mode` is neither `live` nor `historic`                            |
| `invalid-range`        | 400    | `range` is not one of the offered presets                          |
| `invalid-time`         | 400    | `from`/`to` could not be parsed                                    |
| `invalid-window`       | 400    | Window is missing a bound, inverted, or older than 14 days         |
| `missing-region`       | 502    | No region could be resolved from the parameter or AWS config       |
| `invalid-source`       | 400    | `source` is neither `cloudwatch` nor `archive`                     |
| `invalid-level`        | 400    | `level` is not a known level, or was used with `source=cloudwatch` |
| `invalid-group-by`     | 400    | `by` is neither `event` nor `request`                              |
| `too-many-groups`      | 400    | `groups` names more than 10 log groups                             |
| `unsupported-source`   | 400    | `/api/series` was asked for a source it cannot aggregate           |
| `missing-region-param` | 400    | `source=archive` without a region (archived rows are per region)   |
| `missing-credentials`  | 502    | No credentials could be resolved for a real AWS endpoint           |
| `access-denied`        | 502    | CloudWatch Logs refused the call                                   |
| `not-found`            | 502    | The log group does not exist                                       |
| `throttled`            | 502    | CloudWatch Logs is rate limiting                                   |
| `unreachable`          | 502    | Endpoint/DNS/connection failure                                    |
| `aborted`              | 499    | The client closed the request before CloudWatch replied            |
| `unknown`              | 502    | Anything else                                                      |

## Configuration

Ambient AWS credentials only, resolved by the SDK default provider chain
(`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, shared credentials file,
SSO, instance metadata). The app never stores credentials.

When `scripts/dev.ts` is used with `--profile`, it sets `AWS_PROFILE` in the child process and blanks
the local-emulator variables (`AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_LOGS`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) so a leftover `.env.local` cannot redirect a real-AWS
run; blank values are ignored by the SDK and by `normalize()`. It also resolves the region before
starting (`--region`, then the shell's `AWS_REGION`/`AWS_DEFAULT_REGION`, then the profile's `region`
in `~/.aws/config`) because the SDK rejects an empty `AWS_REGION` string.

`WATCH_TAIL_ARCHIVE` and `WATCH_TAIL_ARCHIVE_DB` are also set by the CLI (`--no-archive` and
`--db`), and a blank value means "unset" for both. Inside a test process (`VITEST` or
`NODE_ENV=test`) the archive is off unless a test names a database explicitly, so a test run can never
append to the archive of the machine it runs on.

The archive itself is documented under [Reading the archive](#reading-the-archive-sourcearchive). Its
driver, `@duckdb/node-api`, is an **optional dependency**: it is imported lazily, so a platform without
a prebuilt native binding (or an install made with `--no-optional`) still runs the app, without
history. The import specifier is held in a variable on purpose, so Vite leaves it external and Node
resolves it at run time - bundling the driver fails (`duckdb.node` is not UTF-8).

SvelteKit exposes `.env` values through `$env/dynamic/private`, but the AWS SDK reads
`process.env` directly. `src/lib/server/env.ts` therefore loads `.env.local` into the process
once at startup (existing variables win, `node --env-file` semantics). `pnpm floci:up` writes
that file with the floci endpoint and its throwaway credentials.

| Variable                            | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Region before the ambient profile region; unset falls through           |
| `AWS_ENDPOINT_URL_LOGS`             | CloudWatch Logs endpoint override (checked first)                       |
| `AWS_ENDPOINT_URL_STS`              | STS endpoint override for identity and archive account verification     |
| `AWS_ENDPOINT_URL`                  | Global endpoint override; set to `http://localhost:4566` for floci      |
| `WATCH_TAIL_REGIONS`                | Narrow the picker; unset offers every CloudWatch Logs region            |
| `WATCH_TAIL_LIMIT`                  | Default page size for `describe-log-groups`                             |
| `WATCH_TAIL_ARCHIVE`                | `off` disables the local history archive                                |
| `WATCH_TAIL_ARCHIVE_DIR`            | Root directory for account/region archives (default: platform data dir) |
| `WATCH_TAIL_ARCHIVE_DB`             | Explicit file override, bypassing account/region separation             |

## Request duration chart

The chart defaults to bucketed counts. `metric=duration` on `/api/series` returns one point per
request ID and log group, with `t` at the earliest event and `durationMs` equal to latest timestamp
minus earliest timestamp plus the latest event's declared duration. `events` is 1 for these points,
so legends count requests, not milliseconds. This mode always groups by request regardless of `by`.

`request-duration.ts` parses finite, non-negative JSON `duration` / `durationMs` values in milliseconds,
including numeric strings and prefixed JSON payloads. Missing or invalid durations add zero. Client
and archive paths share this parser. DuckDB selects the final message by timestamp then archive
sequence; the client uses timestamp then arrival order. Earlier events' durations are not added.
Requests without an ID are omitted. Only observed events in the selected window contribute, so
partial windows/buffers can understate the full duration. Count mode retains its existing behavior.
