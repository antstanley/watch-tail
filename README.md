<div align="center">

# watch-tail

**CloudWatch logs. One command. A clearer picture.**

Tail live logs, investigate an incident across services, and keep what you find in a local archive.
Uses your existing AWS credentials. Runs on your machine.

[![npm version](https://img.shields.io/npm/v/watch-tail?color=blue)](https://www.npmjs.com/package/watch-tail)
[![CI](https://github.com/antstanley/watch-tail/actions/workflows/ci.yml/badge.svg)](https://github.com/antstanley/watch-tail/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/watch-tail)](./LICENSE)
[![node](https://img.shields.io/node/v/watch-tail)](package.json)

<img src="https://raw.githubusercontent.com/antstanley/watch-tail/v0.7.1/docs/watch-tail-overview.png" alt="watch-tail: historic logs from multiple groups, with severity chart and request grouping" width="1200">

</div>

## Start here

```bash
npx watch-tail                                          # use your existing AWS credentials
npx watch-tail --profile my-profile --region af-south-1  # choose a profile and region
npx watch-tail --floci                                  # use a local emulator
```

Requires **Node.js 22+**. Prefer a global install? `npm install -g watch-tail` gives you both
`watch-tail` and the shorter `wt`. Press **Ctrl+C** to stop, including during a live stream or login prompt.

Choose a **Theme** from the header: Midnight, Ocean, Forest and Plum are dark palettes;
Daylight, Sand, Mint and Lavender are light palettes. The choice is remembered in this browser.

Need the interface larger? Set **Text size** in the header to Large or Extra large. It scales the
whole UI, including the log view, and is remembered in this browser.

## What you get

- **Live tail and historic scans.** Follow new events or select a preset (15 minutes to 5 days) or
  custom window. Pause with buffering, filter text, clear the view, and toggle auto-scroll.
- **Several groups, one view.** Select groups in the sidebar to merge their logs and chart. A group
  column keeps each line's source visible.
- **Requests, not just lines.** **By request** groups matching request IDs into one expandable row,
  showing line count, elapsed span, and highest severity. Lines without an ID stay visible.
- **Spot the spike.** In Historic mode, the chart shows request duration over time, coloured by severity.
  Drag to zoom into an incident; severity chips filter both chart and logs. Choose **Count** and switch off **By request**
  to count individual events. Collapse the chart when you want the space back.
- **Readable payloads.** Syntax-coloured JSON, expandable payloads, wrapping, horizontal scrolling,
  and resizable sidebar, timestamp, group-name and stream-name columns (drag their edges or use arrow keys). The viewer keeps a 5,000-line buffer.
- **Offline history.** Streamed events are saved to a local DuckDB archive. Browse them later without
  AWS credentials, or query them with SQL.
- **Reopen the same view.** Region, groups, source, mode, and time window live in the URL. A teammate
  needs their own AWS access or a copy of the archive; the link does not include logs or credentials.

## Follow a request

Grouping is on by default. Click a request row to expand its lines; use **By request** to return to
individual events. IDs are detected from `requestId`, `request_id`, `awsRequestId`, `x-request-id`,
and Lambda's `RequestId:` lines. Each request takes the severity of its most critical line.

<img src="https://raw.githubusercontent.com/antstanley/watch-tail/v0.7.1/docs/watch-tail-requests.png" alt="watch-tail: an expanded checkout request showing its JSON payloads and Lambda log lines" width="1200">

Select a chart point to scroll to and highlight its loaded log lines. Requests expand automatically,
and auto-scroll switches off so incoming logs do not move you away. Count points select all matching
events or requests in that bucket; duration points select one request. Use **Clear selection** to
remove the highlight. If filters hide selected lines or they are outside the loaded buffer, the
viewer shows a message.

In **Historic**, drag across the chart to narrow the window. Click the background to clear the brush, or use
**Reset zoom** to restore the preset. CloudWatch charts reflect the events loaded into the viewer;
archive charts query the whole selected window.

The chart stays fixed above the scrolling logs and defaults to **Duration (ms)**, with one point per request: X is its first
observed event timestamp; Y is `(last timestamp + last event duration) − first timestamp` in
milliseconds. The last event's JSON `duration` (or `durationMs`) is used when present; otherwise it
adds zero. Hover for the request ID and duration. Severity filters and chart zoom work in both modes.
Only events with request IDs contribute; incomplete windows can show partial durations.

## Keep your history

Choose **Local archive** to browse events already captured on this machine, even offline or with an
expired SSO session. Only events received while streaming are archived; it does not back up your
whole AWS account.

```bash
watch-tail --db ./logs.duckdb   # choose an archive file
watch-tail --no-archive        # disable archiving
```

<img src="https://raw.githubusercontent.com/antstanley/watch-tail/v0.7.1/docs/watch-tail-archive.png" alt="watch-tail: local archive replay with stored event counts and a severity chart" width="1200">

Each AWS account and region gets its own `<account-id>/<region>/archive.duckdb` beneath:

| Platform | Directory                                      |
| -------- | ---------------------------------------------- |
| macOS    | `~/Library/Application Support/watch-tail/`    |
| Linux    | `${XDG_DATA_HOME:-~/.local/share}/watch-tail/` |
| Windows  | `%LOCALAPPDATA%\watch-tail\`                   |

Account IDs come from AWS STS, so two profiles for the same account share its regional archive.
Changing regions switches files automatically. Emulator endpoints have a separate namespace.
Account mappings are cached locally for offline reads; a new CloudWatch stream verifies its account
before archiving. If verification fails, logs still stream but are not archived.

Existing `archive.duckdb` files stay untouched. Open a legacy archive with `--db /path/to/archive.duckdb`.
`--db` deliberately overrides automatic account/region separation: use it to inspect an existing file
or manage a file yourself. For offline access on another machine, copy the regional database and
open it with `--db`.

DuckDB is optional: if its native driver cannot load, the viewer runs without archiving. One process
can own an archive file at a time; use separate `--db` paths for concurrent instances. To inspect it
with a DuckDB client, stop the app first:

```sql
SELECT log_group, level, count(*) AS events
FROM log_events
GROUP BY log_group, level
ORDER BY events DESC;
```

CloudWatch scans in this app are limited to the last 14 days; actual AWS retention depends on the
log group's settings. The local archive can retain events beyond that window.

## CLI

```
watch-tail [options]

  -p, --profile <name>   AWS profile to use (default: ambient credentials)
  -r, --region <code>    Region to open on (default: profile region, else AWS_REGION)
      --endpoint <url>   Point the app at a local emulator instead of AWS
      --floci            Shorthand for --endpoint http://localhost:4566
      --port <number>    Port for the local UI (default 4517)
      --host <address>   Interface to bind (default 127.0.0.1, loopback only)
      --no-open          Do not open a browser window
      --print            Print the environment that would be used, then exit
      --list             List the AWS profiles found on disk, then exit
      --verbose          Log the server's own output
      --db <path>        Explicit archive file (default: per account and region)
      --no-archive       Do not keep a local history archive
  -h, --help             Show this help
  -v, --version          Show the version
```

Shell completions support zsh, bash, fish, and PowerShell, including your AWS profile names and
available regions:

```bash
source <(watch-tail complete zsh)
```

## AWS access

Uses the AWS SDK credential chain: SSO, shared config, environment variables, or an instance role.
The server binds to loopback by default. No vendor account or deployed agent is needed.

```bash
aws sso login --profile my-profile
wt --profile my-profile
```

The app reads logs using these IAM actions:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": ["logs:DescribeLogGroups", "logs:FilterLogEvents"],
			"Resource": "*"
		}
	]
}
```

If credentials fail, the CLI can help you choose a profile and offer `aws sso login` or `aws login`
as appropriate. Working profiles are checked before offering login. In a non-interactive session it
prints the command to run instead.

Region precedence: `--region`, `AWS_REGION` / `AWS_DEFAULT_REGION`, the chosen profile, then the
default profile. Use `--floci` or `--endpoint` to select an emulator explicitly; emulator settings
from the checkout's `.env.local` do not silently redirect a normal CLI run.

## Local development

With [floci](https://floci.io) installed:

```bash
pnpm install
pnpm floci:up       # start the emulator and write its dev environment
pnpm seed          # demo logs; use pnpm seed:watch for live traffic
pnpm dev           # http://localhost:5173
```

Use `pnpm dev:aws --profile my-profile` to develop against AWS instead.

| Command                     | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm verify`               | Types, lint, formatting, tests, unused-code checks, and build                      |
| `pnpm test:e2e`             | Emulator integration tests (requires floci)                                        |
| `pnpm test:cli`             | Built CLI startup and shutdown checks (Python 3 for terminal tests on macOS/Linux) |
| `pnpm test:ui`              | Browser smoke checks against the running app                                       |
| `pnpm build` / `pnpm start` | Build and run the production CLI                                                   |
| `pnpm publish:check`        | Validate package metadata and tarball contents                                     |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for internals,
[CHANGELOG.md](./CHANGELOG.md) for release history, and [RELEASING.md](./RELEASING.md) for the
Changesets and npm staged-publishing workflow.

## License

[MIT](./LICENSE)
