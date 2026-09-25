# watch-tail

## 0.10.1

### Patch Changes

- [#38](https://github.com/antstanley/watch-tail/pull/38) [`50e7342`](https://github.com/antstanley/watch-tail/commit/50e7342abc447f5ddd2874f21bb20d41b8547b8c) Thanks [@antstanley](https://github.com/antstanley)! - Add a 30-second manga-style trailer to the top of the README, with a link to the
  [watch-tail-hype](https://github.com/antstanley/watch-tail-hype) repository that renders it.

- [#40](https://github.com/antstanley/watch-tail/pull/40) [`c664328`](https://github.com/antstanley/watch-tail/commit/c664328045a4e479bc03221344b50d9fc539cfdf) Thanks [@antstanley](https://github.com/antstanley)! - Shrink the npm package from 7.0 MB to 1.7 MB unpacked (1.9 MB to 0.5 MB packed), and the install
  from about 90 MB to 22 MB. The chart library is no longer compiled into the server build, source
  maps and pre-compressed `.gz`/`.br` copies no longer ship, and `layerchart` and `@lucide/svelte`
  are no longer installed as dependencies, since the build already bundles them. A new
  `pnpm check:package` step keeps the package within a size budget in CI.

## 0.10.0

### Minor Changes

- [#35](https://github.com/antstanley/watch-tail/pull/35) [`72901f9`](https://github.com/antstanley/watch-tail/commit/72901f9818e7620ee9254fc47598806a8cb3cf05) Thanks [@antstanley](https://github.com/antstanley)! - Historic views now prefer the local archive. With **CloudWatch** selected, a historic window reads
  the events the archive already holds and only asks CloudWatch for the ranges it has never seen, so
  re-investigating a window is faster and uses less AWS. watch-tail records which ranges it actually
  read from CloudWatch (following every result page) and stored, so it never skips a period it did
  not stream: uncovered gaps are always fetched from AWS, and so are the last five minutes of any
  read, because CloudWatch can still be ingesting them. A range is never recorded when its events
  could not be written. A CloudWatch historic view now also honours `max` across all its groups. A CloudWatch **filter
  pattern** keeps a request entirely on the API, because that scan archived only the matching lines,
  and **Local archive** is still how you read windows older than CloudWatch's 14-day limit.

- [`4a86680`](https://github.com/antstanley/watch-tail/commit/4a866802c0a96a969a75e1507ba502f8140829dc) Thanks [@antstanley](https://github.com/antstanley)! - Add a chevron on the group-list sidebar's edge that folds the sidebar away, giving the logs the full width. The collapsed state is remembered, and a slim rail keeps the control on the seam.

- [#35](https://github.com/antstanley/watch-tail/pull/35) [`72901f9`](https://github.com/antstanley/watch-tail/commit/72901f9818e7620ee9254fc47598806a8cb3cf05) Thanks [@antstanley](https://github.com/antstanley)! - Add a headless **MCP server**, so an agent can search CloudWatch and the local archive directly
  instead of calling AWS itself. `watch-tail mcp` speaks the Model Context Protocol over stdio (through
  [tmcp](https://tmcp.io), including the stateless `2026-07-28` revision), starting a private
  watch-tail on a free loopback port and stopping it when the agent disconnects. It offers
  `archive_status`, `list_log_groups`, `search_logs`, `count_logs` and `get_identity`. Searches default
  to `source="cloudwatch"`, which reads the local DuckDB archive first and only calls AWS for the
  ranges it does not hold; `source="archive"` stays entirely local, with no AWS calls and no 14-day
  limit. Results come back oldest first, capped by `limit` on either source. The private server
  releases the archive file between tool calls, so an open agent session does not lock the browser UI
  out of the archive.

  `watch-tail mcp init` auto-detects installed agents (Claude Desktop, Claude Code, Cursor, Windsurf,
  VS Code, Gemini CLI and the Codex CLI), lists them, and merges a `watch-tail` server into each
  selected config without disturbing anything else in the file, including settings you added to the
  `watch-tail` entry itself (such as an `env`). Files are replaced atomically and keep their
  permissions. `--yes`, `--agent`, `--scope`,
  `--print`, `--command` and `--args` cover scripted and local-build setups.

- [`9f5e175`](https://github.com/antstanley/watch-tail/commit/9f5e175dd4366846dde2af0e741852e3358a0c49) Thanks [@antstanley](https://github.com/antstanley)! - Rework the panel layout: the group list, chart and log lines now share a matching header bar, each section collapses from its own header, and the panels tile together with single borders. Folding the log lines away lets the chart grow to fill the space.

- [#34](https://github.com/antstanley/watch-tail/pull/34) [`d35f2c6`](https://github.com/antstanley/watch-tail/commit/d35f2c6abde2ada72c6dee8f541e84a869e223b9) Thanks [@antstanley](https://github.com/antstanley)! - Add a **Puppy** button to the header that brings out a Labrador puppy companion in the bottom-right corner. It wags its tail whenever data loads (log groups, log lines, archive counts) and whenever a section folds or unfolds, and goes away when the button is pressed again. Click the puppy for an excited burst of wagging, and drag it (or use the arrow keys) into any corner of the screen; the corner is remembered.

- [`a8738f6`](https://github.com/antstanley/watch-tail/commit/a8738f6b5d6712cb547b60f115680639801c4e95) Thanks [@antstanley](https://github.com/antstanley)! - Add a persistent **Text size** selector to the header: Small, Default, Large and Extra large scale the whole interface, log view included, for readers who need it larger.

### Patch Changes

- [#37](https://github.com/antstanley/watch-tail/pull/37) [`0cb8a86`](https://github.com/antstanley/watch-tail/commit/0cb8a86a71c5141eeaafab72bccd17e458d208ed) Thanks [@antstanley](https://github.com/antstanley)! - Fix the **Local archive** group list hiding every group name on windows 1280px and wider. The
  archived time range beside each count now appears only when the group list itself is wide enough
  for it, and a group name always keeps room in its row.

- [`27fd792`](https://github.com/antstanley/watch-tail/commit/27fd792adc2f502f451cb5045600c9ba3b51eca1) Thanks [@antstanley](https://github.com/antstanley)! - Replace the text glyphs used for controls — chart and log chevrons, the sidebar toggle, and the window range arrow — with Lucide icons.

- [#36](https://github.com/antstanley/watch-tail/pull/36) [`6622897`](https://github.com/antstanley/watch-tail/commit/6622897512e3fc5549f78aa3e79ff191aa459a3c) Thanks [@antstanley](https://github.com/antstanley)! - Refresh the README and its screenshots for the current interface: the reworked panels, chart-point
  selection, the local archive view, and a new **Make it yours** section covering themes, text size and
  the puppy companion. The README also introduces the MCP server up front and describes the
  archive-first coverage rules as they now work.

## 0.9.0

### Minor Changes

- [#31](https://github.com/antstanley/watch-tail/pull/31) [`ad93b92`](https://github.com/antstanley/watch-tail/commit/ad93b9288313bbe17e73862fc4227ea2e435c378) Thanks [@antstanley](https://github.com/antstanley)! - Add four dark and four light colour themes with a persistent header dropdown. Apply the selected palette to controls, log highlighting and charts.

- [#29](https://github.com/antstanley/watch-tail/pull/29) [`3b2f6f2`](https://github.com/antstanley/watch-tail/commit/3b2f6f26f3f7aa8ebe31406948d76c89a4de8272) Thanks [@antstanley](https://github.com/antstanley)! - Resize timestamp, group and stream columns with persisted widths. Keep the chart fixed above scrolling logs with stable height, and default to request duration.

### Patch Changes

- [#30](https://github.com/antstanley/watch-tail/pull/30) [`1ae43b4`](https://github.com/antstanley/watch-tail/commit/1ae43b40ebf8f8ad8e8b98cc21cb80c6885c4242) Thanks [@antstanley](https://github.com/antstanley)! - Keep trailing log-group path segments visible in narrow sidebars, collapsing prefixes with two dots and retaining the full name on hover and for assistive technology.

## 0.8.0

### Minor Changes

- [#26](https://github.com/antstanley/watch-tail/pull/26) [`8236041`](https://github.com/antstanley/watch-tail/commit/823604159b0403d0914416d0cf7b0759596997fa) Thanks [@antstanley](https://github.com/antstanley)! - Select scatter chart points to scroll to and highlight matching log lines, expand requests, and disable auto-scroll while inspecting them. Keep request IDs scoped to their log group.

### Patch Changes

- [#28](https://github.com/antstanley/watch-tail/pull/28) [`76201a4`](https://github.com/antstanley/watch-tail/commit/76201a48e342163a317d1ed3ea531895a23dfa66) Thanks [@antstanley](https://github.com/antstanley)! - Fix Ctrl+C leaving the dev server running after a log stream has been opened. Preserve normal signal termination across hot reloads, and clean up the CLI child server when startup is cancelled.

  Fix Ctrl+C after choosing an AWS profile: pipe server output through the CLI so a restarting child cannot restore raw terminal settings. Install shutdown handlers before displaying the Ctrl+C instruction, and test the interactive restart with real terminal input.

## 0.7.1

### Patch Changes

- [#24](https://github.com/antstanley/watch-tail/pull/24) [`3894339`](https://github.com/antstanley/watch-tail/commit/389433975edb20f59780399b3c57375608fb5d39) Thanks [@antstanley](https://github.com/antstanley)! - Refresh the README screenshots with the current watch-tail branding and chart controls.

## 0.7.0

### Minor Changes

- [#19](https://github.com/antstanley/watch-tail/pull/19) [`6606840`](https://github.com/antstanley/watch-tail/commit/660684057e9c89a2b052c6ab233c5ad85ca891a6) Thanks [@antstanley](https://github.com/antstanley)! - Store default DuckDB archives separately for each AWS account and region. Verify account IDs with
  STS before writing, isolate emulator endpoints, and cache account mappings for offline reads.
  Region changes now select the matching archive for status, groups, logs, and charts. Existing archives
  remain untouched and can be opened with the explicit `--db` file override.

- [#22](https://github.com/antstanley/watch-tail/pull/22) [`25d62cf`](https://github.com/antstanley/watch-tail/commit/25d62cf6399e03583984f42858cba18cc3cf4117) Thanks [@antstanley](https://github.com/antstanley)! - Rename the project from `watch-stream` to `watch-tail` everywhere it still appeared, so the package,
  the CLI, the docs and the source tree agree on one name. Environment variables are now
  `WATCH_TAIL_REGIONS`, `WATCH_TAIL_LIMIT`, `WATCH_TAIL_ARCHIVE`, `WATCH_TAIL_ARCHIVE_DIR` and
  `WATCH_TAIL_ARCHIVE_DB`, and the browser `localStorage` keys use the `watch-tail:` prefix. Set the new
  names before upgrading: the old `WATCH_STREAM_*` variables are no longer read, and the renamed storage
  keys reset saved layout preferences once.

- [#21](https://github.com/antstanley/watch-tail/pull/21) [`74cdf61`](https://github.com/antstanley/watch-tail/commit/74cdf617a4b79b9ddc89a6d33df8e4db937ed378) Thanks [@antstanley](https://github.com/antstanley)! - Add a Count / Duration (ms) toggle to the chart. Duration mode plots each request at its first event
  with elapsed milliseconds through its last event, adding the last event's JSON duration when present.
  Supports CloudWatch and local archives, severity filters, request tooltips, and chart zoom.

### Patch Changes

- [#23](https://github.com/antstanley/watch-tail/pull/23) [`6dbba8f`](https://github.com/antstanley/watch-tail/commit/6dbba8fb65bfc72e2e2abde3a63806731e92c471) Thanks [@antstanley](https://github.com/antstanley)! - Refresh archive account mappings before reading, using cached identities only when lookup fails.
  Resolve STS endpoints separately from CloudWatch Logs so Logs-specific endpoints do not disable archiving.

## 0.6.2

### Patch Changes

- Refresh the README with demo screenshots and concise guides to request grouping, multi-group
  investigation, chart zooming, and offline archives. Clarify the app’s CloudWatch scan limit and
  explicitly select the `latest` npm dist-tag for stable releases.

## 0.6.1

### Patch Changes

- [#17](https://github.com/antstanley/watch-tail/pull/17) [`a50659c`](https://github.com/antstanley/watch-tail/commit/a50659cfe765c8aa3078fd2934674b32c30b2ec7) Thanks [@antstanley](https://github.com/antstanley)! - Stop the server immediately when it is streaming.

  adapter-node shuts down gracefully: on Ctrl+C it stops accepting connections and waits for the ones
  already open, force-closing them only after `SHUTDOWN_TIMEOUT` - thirty seconds by default. A live tail
  never finishes on its own, so a server with a browser on it took half a minute to stop, which reads
  exactly like "Ctrl+C does not stop the server".

  The app now ends its own event streams when it is asked to stop, so the shutdown completes at once, and
  the stream says why it ended (`server-stopping`) instead of the browser seeing a dead socket. The CLI
  and the dev launcher also pass a two-second `SHUTDOWN_TIMEOUT` as an outer bound. The regression test
  runs the built server with a live tail attached and asserts it exits promptly.

## 0.6.0

### Minor Changes

- [#15](https://github.com/antstanley/watch-tail/pull/15) [`d9ec39b`](https://github.com/antstanley/watch-tail/commit/d9ec39b66aedfa21798e8277525795ec473fe11a) Thanks [@antstanley](https://github.com/antstanley)! - Group the lines of a request into one row, in the log view and in the chart.

  A request id is read from each line - a declared `requestId` (also `request_id`, `awsRequestId`,
  `x-request-id`) or the `RequestId: ...` a Lambda prints - and the lines that share it become one row in
  the log view: the request id, how many lines it wrote, how long it took, and the level of its most
  critical line. Click the row to open every line, indented and in order.

  The chart counts one mark per request instead of one per line, placed where the request started and
  coloured by that same most critical level, so a spike of failing requests is a spike of marks rather
  than a spike of log volume. The archive answers that in one SQL statement, and a CloudWatch view
  buckets the requests it has already streamed.

  It is on by default and the log view's **By request** button turns it off, which the app remembers.
  Lines with no request id are never grouped, so nothing is hidden by an id the log did not have.

### Patch Changes

- [#15](https://github.com/antstanley/watch-tail/pull/15) [`d9ec39b`](https://github.com/antstanley/watch-tail/commit/d9ec39b66aedfa21798e8277525795ec473fe11a) Thanks [@antstanley](https://github.com/antstanley)! - Give the chart tooltip a background.

  layerchart draws its tooltip with colours that come from `--color-surface-*` variables, which only its
  framework presets (shadcn-svelte, Skeleton, daisyUI) define. This app imports none of them, so the
  tooltip rendered fully transparent with black text - unreadable over a dark chart. It now carries its
  own panel styling (dark background, border, light text, elevation shadow), and the browser smoke run
  checks the rendered colours so it cannot regress unnoticed.

- [#15](https://github.com/antstanley/watch-tail/pull/15) [`d9ec39b`](https://github.com/antstanley/watch-tail/commit/d9ec39b66aedfa21798e8277525795ec473fe11a) Thanks [@antstanley](https://github.com/antstanley)! - Make Ctrl+C stop the CLI while a prompt is open.

  Cancelling one of the CLI's questions (the login offer, the profile picker) was read as "No" - so
  Ctrl+C at that prompt looked like it did nothing, and the process carried on with its server still
  running. Worse, the question left the terminal in raw mode, where Ctrl+C no longer produces a signal at
  all, so every later attempt in that terminal was swallowed too.

  A cancelled prompt is now a stop: the CLI says `Cancelled.`, shuts the server down, prints `stopped`,
  exits like any other Ctrl+C, and hands the terminal back in its normal state. If a terminal was already
  left in raw mode by an earlier version, `stty sane` repairs it.

## 0.5.0

### Minor Changes

- [`820a176`](https://github.com/antstanley/watch-tail/commit/820a176f3b47c7c6dafdf726729ac4d526e32458) Thanks [@antstanley](https://github.com/antstanley)! - Keep a local DuckDB archive of everything you stream, and browse it without AWS

  Every event that arrives while a stream is open is now appended to a local DuckDB file
  (`~/Library/Application Support/watch-tail/archive.duckdb` on macOS, the equivalent data directory
  elsewhere). A new **Local archive** source in the UI lists the groups that file holds and replays any
  window from it - instantly, and with no credentials, so history still works with an expired SSO
  session or no AWS access at all. `--db <path>` moves the archive and `--no-archive` switches it off.

  - `GET /api/stream` and `GET /api/log-groups` take a `source` parameter: `cloudwatch` (default) or
    `archive`.
  - `GET /api/archive` reports the file, its size and its contents; it never fails, and reports why the
    archive is unavailable instead.
  - Archived events are de-duplicated by CloudWatch event id, or by a hash of timestamp, stream and
    message when an emulator omits ids, so re-scanning a window does not duplicate rows.
  - Every archived line stores its level (`error`, `warn`, `info`, `debug` or no level at all), taken
    from the level the payload declares when there is one and from the line otherwise. The viewer gains
    level chips to narrow to one severity, and the archive stream accepts a `level` filter.
  - The DuckDB driver is an optional dependency: without it the app behaves exactly as before and says
    so on startup.

- [#14](https://github.com/antstanley/watch-tail/pull/14) [`9529416`](https://github.com/antstanley/watch-tail/commit/95294160d1746d82d449e0d83ce53487d0779258) Thanks [@antstanley](https://github.com/antstanley)! - See the shape of an incident: a level-coloured scatter chart, brushing, and several groups at once

  A scatter chart now sits above the log view. X is time, Y is the number of events in a bucket, and
  every level gets its own colour, so a spike reads as errors or as noise before you scroll a single
  line. Drag across the chart to brush a range: the log view, the window chip and the URL all follow, so
  `?from=&to=` is a shareable view of that moment. A click clears the brush and **Reset zoom** returns to
  the preset window. The level chips filter the chart and the log view together, and the chart's legend
  splits the totals by level.

  The sidebar now takes more than one log group. Ticking extra groups streams them together, adds a
  group column to the view, covers all of them in the chart, and keeps the selection in the URL as
  `groups=a,b` (a single group still uses `group=a`, so older links keep working). The archive reads
  several groups in one SQL statement; CloudWatch runs one tail per group and merges them, so a quiet
  group never holds back a busy one.

  The brush zooms when the drag is released, not while the pointer is down, and a click or a slipped
  pointer clears the brush instead of zooming to a sliver of the window.

  The chart panel collapses to a single header line (totals and per-level counts) and remembers that
  choice, and the charting library is loaded on demand: the chart code is fetched in the browser only
  once the panel is open, so it never delays the log view's first paint (about 235 KiB of chart code
  after the page starts, and none at all while collapsed).

  `GET /api/series` is the chart's data: bucketed counts per group and level, with an automatic bucket
  width, an optional `bucket`, a `level` filter, and no 14-day clamp - the archive keeps what CloudWatch
  has forgotten. The chart is drawn with [layerchart](https://www.layerchart.com).

## 0.4.0

### Minor Changes

- [#11](https://github.com/antstanley/watch-tail/pull/11) [`74ee9c3`](https://github.com/antstanley/watch-tail/commit/74ee9c361d8b2d6e0f3ea38469064d74f90a6116) Thanks [@antstanley](https://github.com/antstanley)! - Open a single log line's JSON on click, and give the app its own icon.

  With pretty-printing switched off, a line that carries JSON shows a marker and
  opens on click: the raw line stays where it is and the payload appears beneath
  it, indented and coloured - including for the "prefix then payload" lines
  CloudWatch often receives. Clicking again, or pressing Enter, closes it. Lines
  without JSON are not controls, so nothing pretends to be clickable.

  The stock framework icon is replaced with one of our own: a log window with the
  newest line highlighted.

- [#12](https://github.com/antstanley/watch-tail/pull/12) [`5214ef5`](https://github.com/antstanley/watch-tail/commit/5214ef52336a0b91d4495113349becc0aaac2f90) Thanks [@antstanley](https://github.com/antstanley)! - Check a chosen profile with STS before offering to log it in.

  Picking a profile no longer assumes it needs a login: the CLI restarts with it and
  asks `sts:GetCallerIdentity` about _that_ profile, so a profile whose SSO session
  is still cached is simply used - "profile beyond-mzansi already works
  (AWSReservedSSO_AWSAdministratorAccess) - using it" - instead of prompting for a
  login anyone would have to cancel. A login is offered only when the chosen
  profile genuinely has nothing usable, and after a successful login the result is
  confirmed with STS and reported by role name.

  Adds `GET /api/identity`, which returns the caller identity for the resolved
  configuration (arn, account, userId, region, endpoint) using the same credentials
  and endpoint resolution as the log routes.

### Patch Changes

- [#9](https://github.com/antstanley/watch-tail/pull/9) [`7bdd21f`](https://github.com/antstanley/watch-tail/commit/7bdd21f6dcd52e498736c5d7ea2dcd2a1c1ef255) Thanks [@antstanley](https://github.com/antstanley)! - Ask which AWS profile to use when credentials fail, and keep prompts working with NO_COLOR set.

  With several profiles configured, a credential failure assumed the ambient default
  and offered to log in there - rarely the account someone meant. The CLI now asks
  which profile to use (a searchable list; skipped when `--profile` or `AWS_PROFILE`
  already answers it, or when only one profile exists), runs the matching login for
  it, and restarts the app with that profile and its own region so the browser lands
  on a working session. Declining still leaves the app running as the chosen profile,
  with the exact command to run.

  `NO_COLOR` no longer disables prompts. It asks for no colour, and reading it as
  "do not prompt" silently skipped the profile and login questions for anyone who
  sets it.

## 0.3.1

### Patch Changes

- [#7](https://github.com/antstanley/watch-tail/pull/7) [`1f7a31a`](https://github.com/antstanley/watch-tail/commit/1f7a31a0b6769e19a6f1a222714b89ea860af6c0) Thanks [@antstanley](https://github.com/antstanley)! - Stop a development `.env.local` from silently redirecting the CLI at the emulator.

  Running `watch-tail` inside a checkout that has a `.env.local` (written by
  `pnpm floci:env` for the dev server) pointed the whole UI at floci instead of
  real AWS. The CLI now suppresses the emulator settings it finds in that file,
  prints which keys it ignored, and tells you `--floci` is the way to use them.
  Values you export yourself still win, and `--floci` still targets the emulator.

## 0.3.0

### Minor Changes

- [#5](https://github.com/antstanley/watch-tail/pull/5) [`3fa9cf0`](https://github.com/antstanley/watch-tail/commit/3fa9cf06335dea11cd936fe317f18f703e408393) Thanks [@antstanley](https://github.com/antstanley)! - Detect unusable AWS credentials at startup, and offer the login that fixes them.

  The CLI now asks the running app for one log group before opening the browser. If
  AWS refuses because of credentials, it reads how the profile is configured and
  offers the matching command: `aws sso login --profile X` for SSO profiles,
  `aws login --profile X` for console sign-in profiles (or one with nothing
  configured yet), and no login at all for static keys or a `credential_process`,
  where the fix is elsewhere. The login runs with the terminal attached, so the
  browser flow works; `--remote` is added on headless hosts. Decline, and it prints
  the command instead and leaves the app running. Emulator runs skip the check.

## 0.2.1

### Patch Changes

- [#3](https://github.com/antstanley/watch-tail/pull/3) [`5916b69`](https://github.com/antstanley/watch-tail/commit/5916b694c9574c55f656ea35804463a4305c0331) Thanks [@antstanley](https://github.com/antstanley)! - Make shell completions complete the values that matter.

  `--profile` now offers the profiles from your own AWS config instead of just
  `default`, `--region` offers the CloudWatch Logs region list, `--open` is
  completable, and the stray `presets` pseudo-command is gone. The completion
  protocol is covered by tests, including a generated script for each supported
  shell.

## 0.2.0

### Minor Changes

- [#1](https://github.com/antstanley/watch-tail/pull/1) [`bc807a3`](https://github.com/antstanley/watch-tail/commit/bc807a38bbfc4aae92252a3e0871a8a41de556bd) Thanks [@antstanley](https://github.com/antstanley)! - Add a `wt` shorthand for the CLI.

  Installing the package globally now provides `wt` alongside `watch-tail`, so the
  common case is three characters: `wt --profile my-profile`. Both names run the
  same binary.

## 0.1.0

### Minor Changes

- [`17766f5`](https://github.com/antstanley/watch-tail/commit/17766f594f6c7135bf53ec895e3f3acc04ce4faf) Thanks [@antstanley](https://github.com/antstanley)! - First public release of `watch-tail`.

  `npx watch-tail` starts a local UI for Amazon CloudWatch Logs and streams a log
  group into your browser: region and group pickers, live tailing over SSE, historic
  scans (15m/1h/3h/12h/24h/5d or a custom window), JSON pretty-printing, resizable
  columns, and ambient AWS credentials throughout. It runs against real AWS, or
  against the floci emulator with `--floci`.
