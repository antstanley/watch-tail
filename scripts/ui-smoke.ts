#!/usr/bin/env node
/**
 * Browser smoke check for the log window.
 *
 * Unit and component tests live in vitest (`pnpm test`). This script covers the
 * things only a real browser can show: horizontal scrolling, the wrap and JSON
 * toggles, and dragging the two resizable columns. It drives Playwright with the
 * already-installed Google Chrome (`--channel chrome`), so no browser download is
 * needed, and it never writes to AWS: it only loads the page and reads the DOM.
 *
 * Usage:
 *   node scripts/ui-smoke.ts                                  # http://localhost:5173
 *   node scripts/ui-smoke.ts --url http://localhost:5196 --group /aws/lambda/checkout-api
 *   node scripts/ui-smoke.ts --screenshot /tmp/ui.png --timeout 20000 --channel chromium
 *   node scripts/ui-smoke.ts --help
 *
 * Exit code 0 when every check passes, 1 when a check fails, 2 for bad arguments.
 */
import { chromium } from 'playwright';
import type { Browser } from 'playwright';

type Options = {
	url: string;
	region: string | null;
	group: string | null;
	channel: string;
	screenshot: string | null;
	timeout: number;
};

type Check = { name: string; ok: boolean; detail: string };

const USAGE = `Usage: node scripts/ui-smoke.ts [options]

  --url <base>         app base URL (default http://localhost:5173)
  --region <code>      region to pass in the query string
  --group <name>       log group to select (default: first row in the list)
  --channel <name>     Playwright browser channel (default chrome)
  --timeout <ms>       per-step timeout (default 15000)
  --screenshot <path>  write a PNG of the final state
  --help               show this text`;

/** Parses the command line; never throws. */
function parseArgs(argv: string[]): { ok: true; options: Options } | { ok: false; error: string } {
	const options: Options = {
		url: 'http://localhost:5173',
		region: null,
		group: null,
		channel: 'chrome',
		screenshot: null,
		timeout: 15_000,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const raw = argv[index];
		if (raw === '--') continue;
		if (raw === '--help' || raw === '-h') return { ok: true, options: { ...options, url: '' } };
		if (raw === '--screenshot' && argv[index + 1] === undefined) {
			return { ok: false, error: 'Missing value for --screenshot' };
		}
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
		if (match === null) return { ok: false, error: `Unknown option "${raw}"` };
		const [, name, inline] = match;
		const value = inline ?? argv[index + 1];
		if (value === undefined) return { ok: false, error: `Missing value for --${name}` };
		if (inline === undefined) index += 1;

		switch (name) {
			case 'url':
				options.url = value;
				break;
			case 'region':
				options.region = value;
				break;
			case 'group':
				options.group = value;
				break;
			case 'channel':
				options.channel = value;
				break;
			case 'screenshot':
				options.screenshot = value;
				break;
			case 'timeout': {
				const parsed = Number(value);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					return { ok: false, error: `Invalid --timeout value "${value}"` };
				}
				options.timeout = parsed;
				break;
			}
			default:
				return { ok: false, error: `Unknown option "--${name}"` };
		}
	}

	if (options.url === '') return { ok: false, error: '__help__' };
	return { ok: true, options };
}

/** Builds the page URL with the region and group query parameters. */
function pageUrl(options: Options, group: string | null): string {
	const url = new URL(options.url);
	if (options.region !== null) url.searchParams.set('region', options.region);
	if (group !== null) url.searchParams.set('group', group);
	return url.toString();
}

/** True when a computed colour is actually painted, rather than transparent. */
function painted(value: string): boolean {
	return (
		value !== '' &&
		value !== 'transparent' &&
		!/^rgba\([^)]*,\s*0(\.0+)?\)$/.test(value) &&
		value !== 'rgba(0, 0, 0, 0)'
	);
}

/** Records a check result. */
function check(checks: Check[], name: string, ok: boolean, detail = ''): void {
	checks.push({ name, ok, detail });
}

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		if (parsed.error !== '__help__') console.error(`ui-smoke: ${parsed.error}`);
		console.error(USAGE);
		return 2;
	}
	const options = parsed.options;
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log(USAGE);
		return 0;
	}

	let browser: Browser | null = null;
	const checks: Check[] = [];
	try {
		// `channel: chrome` uses the Google Chrome already on the machine.
		browser = await chromium.launch({
			...(options.channel === 'chromium' ? {} : { channel: options.channel }),
			headless: true,
		});
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

		const health = await (
			await page.request.get(new URL('/api/health', options.url).toString())
		).json();
		console.log(
			`api: ok=${String(health.ok)} region=${String(health.region)} endpoint=${String(health.endpoint)} credentials=${String(health.credentials)}`,
		);

		await page.goto(pageUrl(options, null), { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-testid="group-row"]', { timeout: options.timeout });
		const rows = await page.locator('[data-testid="group-row"]').count();
		check(checks, 'log groups listed', rows > 0, `${rows} rows`);

		const group =
			options.group ??
			(await page.locator('[data-testid="group-row"]').first().getAttribute('data-group-name')) ??
			'';
		await page.goto(pageUrl(options, group), { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-testid="log-scroller"]', { timeout: options.timeout });
		check(
			checks,
			'group selected',
			(await page.textContent('[data-testid="status-badge"]')) !== null,
		);

		// Grouping by request is on by default. Check it here, open one request, and
		// then turn it off so the line-level checks below look at individual lines -
		// a request's lines are hidden until its row is opened.
		let requests = 0;
		try {
			await page.waitForSelector('[data-testid="log-request-group"]', { timeout: options.timeout });
			requests = await page.locator('[data-testid="log-request-group"]').count();
		} catch {
			requests = 0;
		}
		check(checks, 'requests are grouped', requests > 0, `${requests} requests`);
		if (requests > 0) {
			await page.locator('[data-testid="request-group-summary"]').first().click();
			const children = await page
				.locator('[data-testid="log-line"][data-request-child="true"]')
				.count();
			check(checks, 'a request opens to show its lines', children > 0, `${children} lines`);
			await page.locator('[data-testid="request-group-summary"]').first().click();
			await page.click('[data-testid="group-toggle"]');
			const grouped = await page.getAttribute('[data-testid="group-toggle"]', 'aria-pressed');
			check(checks, 'grouping can be turned off', grouped === 'false', String(grouped));
		}

		// Both chart metrics must remain available independently of log-row grouping.
		await page.getByTestId('chart-metric-duration').click();
		check(
			checks,
			'duration chart can be selected',
			(await page.getByTestId('chart-metric-duration').getAttribute('aria-pressed')) === 'true',
		);
		if (requests > 0) {
			await page.waitForFunction(() =>
				document.querySelector('[data-testid="scatter-chart"]')?.textContent?.includes(' ms'),
			);
			check(
				checks,
				'duration axis uses milliseconds',
				(await page.getByTestId('scatter-chart').textContent())?.includes(' ms') === true,
			);
		}
		await page.getByTestId('chart-metric-count').click();
		check(
			checks,
			'count chart can be restored',
			(await page.getByTestId('chart-metric-count').getAttribute('aria-pressed')) === 'true',
		);

		/**
		 * Hover a chart mark and read the tooltip's computed colours.
		 *
		 * layerchart's own tooltip background comes from CSS variables that only its
		 * framework presets (shadcn-svelte, Skeleton, daisyUI) define; this app uses
		 * none of them, so the tooltip used to render fully transparent with black
		 * text. Only a real browser can see that, which is why the check lives here.
		 */
		async function hoverTooltip(): Promise<{ background: string; color: string } | null> {
			try {
				await page.waitForSelector('[data-testid="scatter-chart"] svg circle', {
					timeout: options.timeout,
				});
			} catch {
				return null;
			}
			const circles = page.locator('[data-testid="scatter-chart"] svg circle');
			const count = Math.min(await circles.count(), 40);
			for (let index = 0; index < count; index += 1) {
				const box = await circles.nth(index).boundingBox();
				if (box === null) continue;
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.waitForTimeout(60);
				if ((await page.locator('.lc-tooltip-container').count()) === 0) continue;
				return await page
					.locator('.lc-tooltip-container')
					.first()
					.evaluate((el) => {
						const style = getComputedStyle(el);
						return { background: style.backgroundColor, color: style.color };
					});
			}
			return null;
		}

		const tooltip = await hoverTooltip();
		check(
			checks,
			'chart tooltip has a background',
			tooltip === null ? true : painted(tooltip.background) && painted(tooltip.color),
			tooltip === null
				? 'no chart points to hover'
				: `background=${tooltip.background} text=${tooltip.color}`,
		);

		let lines = 0;
		try {
			await page.waitForSelector('[data-testid="log-line"]', { timeout: options.timeout });
			lines = await page.locator('[data-testid="log-line"]').count();
		} catch {
			lines = 0;
		}
		check(
			checks,
			'log lines rendered',
			lines > 0,
			lines === 0 ? 'no events in the lookback window' : `${lines} lines`,
		);

		const layout = await page.evaluate(() => {
			const viewportWidth = window.innerWidth;
			const viewportHeight = window.innerHeight;
			const mainElement = document.querySelector('main');
			const sidebar = document.querySelector('[data-testid="sidebar"]');
			const scroller = document.querySelector('[data-testid="log-scroller"]');
			const mainBox = mainElement?.getBoundingClientRect();
			const sidebarBox = sidebar?.getBoundingClientRect();
			const scrollerBox = scroller?.getBoundingClientRect();
			return {
				leftGutter: Math.round(mainBox?.left ?? -1),
				rightGutter: Math.round(viewportWidth - (scrollerBox?.right ?? viewportWidth)),
				emptyBelow: Math.round(viewportHeight - (sidebarBox?.bottom ?? viewportHeight)),
				pageScrolls: document.documentElement.scrollHeight > viewportHeight + 1,
			};
		});
		check(
			checks,
			'layout is left-aligned',
			layout.leftGutter <= 32,
			`${layout.leftGutter}px gutter`,
		);
		check(
			checks,
			'log window fills the width',
			layout.rightGutter <= 32,
			`${layout.rightGutter}px gutter`,
		);
		check(
			checks,
			'panes fill the viewport height',
			layout.emptyBelow <= 32,
			`${layout.emptyBelow}px below`,
		);
		check(checks, 'the page itself does not scroll', !layout.pageScrolls);

		// A long group list must scroll inside its pane instead of growing the page.
		const listOverflow = await page.evaluate(() => {
			const ul = document.querySelector('ul:has([data-testid="group-row"])');
			if (ul === null) return null;
			const style = getComputedStyle(ul);
			return {
				overflows: ul.scrollHeight > ul.clientHeight + 1,
				scrollable: style.overflowY === 'auto' || style.overflowY === 'scroll',
			};
		});
		check(
			checks,
			'the group list scrolls inside its pane',
			listOverflow === null || !listOverflow.overflows || listOverflow.scrollable,
			listOverflow === null
				? 'no list rendered'
				: `${listOverflow.scrollable ? 'scrollable' : 'not scrollable'}`,
		);

		const scroll = await page.evaluate(() => {
			const scroller = document.querySelector('[data-testid="log-scroller"]') as HTMLElement;
			const message = document.querySelector('[data-testid="log-message"]');
			const stream = document.querySelector('[data-testid="log-stream"]');
			return {
				overflowX: getComputedStyle(scroller).overflowX,
				whiteSpace: message === null ? '' : getComputedStyle(message).whiteSpace,
				streamOverflow: stream === null ? '' : getComputedStyle(stream).textOverflow,
				streamTitle: stream?.getAttribute('title') ?? '',
				streamText: stream?.textContent ?? '',
			};
		});
		check(checks, 'horizontal scrolling enabled', scroll.overflowX === 'auto', scroll.overflowX);
		check(checks, 'lines do not wrap by default', scroll.whiteSpace === 'pre', scroll.whiteSpace);
		check(
			checks,
			'stream column truncates with a tooltip',
			scroll.streamTitle === scroll.streamText && scroll.streamOverflow === 'ellipsis',
			`${scroll.streamText.length} chars`,
		);

		if (lines > 0) {
			await page.click('[data-testid="wrap-toggle"]');
			const wrapped = await page.evaluate(
				() =>
					getComputedStyle(document.querySelector('[data-testid="log-message"]') as Element)
						.whiteSpace,
			);
			check(checks, 'wrap toggle switches to pre-wrap', wrapped === 'pre-wrap', wrapped);
			await page.click('[data-testid="wrap-toggle"]');

			// Look only at messages that are JSON, so multi-line non-JSON lines
			// (stack traces) cannot make this check lie.
			const jsonState = (): Promise<{ total: number; multiline: number }> =>
				page.evaluate(() => {
					const json = [...document.querySelectorAll('[data-testid="log-message"]')].filter((el) =>
						(el.textContent ?? '').trimStart().startsWith('{'),
					);
					return {
						total: json.length,
						multiline: json.filter((el) => (el.textContent ?? '').includes('\n')).length,
					};
				});

			const pretty = await jsonState();
			await page.click('[data-testid="json-toggle"]');
			const rawToggle = await page.getAttribute('[data-testid="json-toggle"]', 'aria-pressed');
			const raw = await jsonState();
			// Every JSON message must be expanded while the toggle is on, and turning
			// it off must never expand more. A raw message can still carry newlines of
			// its own (CloudWatch sometimes stores pre-formatted JSON), so `raw` is
			// compared against `pretty` rather than against zero.
			check(
				checks,
				'json pretty-printing expands every JSON line',
				pretty.total === 0 ||
					(pretty.multiline === pretty.total && raw.multiline <= pretty.multiline),
				pretty.total === 0
					? 'no JSON lines in this group'
					: `${pretty.total} JSON lines: pretty=${pretty.multiline}, raw=${raw.multiline}`,
			);
			check(checks, 'json toggle reports its state', rawToggle === 'false', String(rawToggle));

			// Still with pretty-printing off, a line that carries JSON opens on click.
			const expandable = page.locator('[data-testid="log-line"][data-expandable="true"]');
			const expandableCount = await expandable.count();
			if (expandableCount === 0) {
				check(checks, 'JSON lines expand on click', true, 'no JSON lines in this group');
			} else {
				const target = expandable.first();
				await target.click();
				const opened = await page.locator('[data-testid="log-json-expanded"]').count();
				const expandedText =
					opened > 0
						? await page.locator('[data-testid="log-json-expanded"]').first().textContent()
						: '';
				await target.click();
				const closed = await page.locator('[data-testid="log-json-expanded"]').count();
				check(
					checks,
					'JSON lines expand on click',
					opened === 1 && (expandedText ?? '').includes('\n') && closed === 0,
					`${expandableCount} expandable, opened=${opened}, closed=${closed}`,
				);
			}
			// and a line without JSON is not a control
			check(
				checks,
				'plain lines are not clickable',
				(await page
					.locator('[data-testid="log-line"]:not([data-expandable="true"])[aria-expanded]')
					.count()) === 0,
			);
			// back to pretty-printed lines for the remaining checks
			await page.click('[data-testid="json-toggle"]');

			const scrollerBox = await page.locator('[data-testid="log-scroller"]').boundingBox();
			const handle = await page.locator('[data-testid="prefix-resizer"]').boundingBox();
			const prefixBefore = Number(
				await page.getAttribute('[data-testid="prefix-resizer"]', 'aria-valuenow'),
			);
			if (scrollerBox !== null && handle !== null) {
				// The handle spans the whole (tall) log canvas, so grab it inside the visible window.
				const grabY = scrollerBox.y + scrollerBox.height / 2;
				await page.mouse.move(handle.x + 3, grabY);
				await page.mouse.down();
				await page.mouse.move(handle.x + 63, grabY, { steps: 6 });
				await page.mouse.up();
			}
			const prefixAfter = Number(
				await page.getAttribute('[data-testid="prefix-resizer"]', 'aria-valuenow'),
			);
			check(
				checks,
				'prefix column drag resizes',
				prefixAfter === prefixBefore + 60,
				`${prefixBefore} -> ${prefixAfter}`,
			);

			await page.focus('[data-testid="prefix-resizer"]');
			await page.keyboard.press('ArrowLeft');
			const prefixKey = Number(
				await page.getAttribute('[data-testid="prefix-resizer"]', 'aria-valuenow'),
			);
			check(
				checks,
				'prefix column arrow key steps 16px',
				prefixKey === prefixAfter - 16,
				`${prefixAfter} -> ${prefixKey}`,
			);

			const sidebarBox = await page.locator('[data-testid="sidebar-resizer"]').boundingBox();
			const sidebarBefore = Number(
				await page.getAttribute('[data-testid="sidebar-resizer"]', 'aria-valuenow'),
			);
			if (sidebarBox !== null) {
				await page.mouse.move(sidebarBox.x + 3, sidebarBox.y + sidebarBox.height / 2);
				await page.mouse.down();
				await page.mouse.move(sidebarBox.x + 83, sidebarBox.y + sidebarBox.height / 2, {
					steps: 6,
				});
				await page.mouse.up();
			}
			const sidebarAfter = Number(
				await page.getAttribute('[data-testid="sidebar-resizer"]', 'aria-valuenow'),
			);
			check(
				checks,
				'group-list pane drag resizes',
				sidebarAfter > sidebarBefore,
				`${sidebarBefore} -> ${sidebarAfter}`,
			);
			// Resizing metadata must not wrap the columns away from their separators.
			const extraGroup = page.locator('input[data-testid^="group-check-"]:not(:checked)').first();
			if (await extraGroup.count()) {
				await extraGroup.check();
				await page.getByTestId('log-group').first().waitFor();
				await page.getByTestId('wrap-toggle').click();
				await page.getByTestId('log-scroller').evaluate((element) => {
					element.style.width = '600px';
				});
				await page.getByTestId('group-resizer').focus();
				for (let step = 0; step < 32; step += 1) await page.keyboard.press('ArrowRight');
				const geometry = await page.evaluate(() => {
					const groupBox = document
						.querySelector('[data-testid="log-group"]')!
						.getBoundingClientRect();
					const stream = document
						.querySelector('[data-testid="log-stream"]')!
						.getBoundingClientRect();
					const groupHandle = document
						.querySelector('[data-testid="group-resizer"]')!
						.getBoundingClientRect();
					const streamHandle = document
						.querySelector('[data-testid="prefix-resizer"]')!
						.getBoundingClientRect();
					return {
						group: Math.abs(groupBox.right - groupHandle.left - 4),
						stream: Math.abs(stream.right - streamHandle.left - 4),
						sameLine: Math.abs(groupBox.top - stream.top) < 2,
					};
				});
				check(
					checks,
					'wide columns stay aligned in wrap mode',
					geometry.group < 2 && geometry.stream < 2 && geometry.sameLine,
					JSON.stringify(geometry),
				);
				await page.getByTestId('log-scroller').evaluate((element) => {
					element.style.removeProperty('width');
				});
				await page.getByTestId('wrap-toggle').click();
			}
		}

		// Historic windows: the mode toggle, the preset chips and a finite scan.
		await page.click('[data-testid="mode-historic"]');
		await page.waitForTimeout(300);
		const historicPressed = await page.getAttribute(
			'[data-testid="mode-historic"]',
			'aria-pressed',
		);
		const presets = await page.locator('[data-testid^="preset-"]').count();
		check(
			checks,
			'historic mode exposes the presets',
			historicPressed === 'true' && presets >= 7,
			`${presets} options`,
		);

		await page.click('[data-testid="preset-24h"]');
		await page.waitForTimeout(1200);
		const url = page.url();
		const chip = await page.textContent('[data-testid="window-chip"]').catch(() => null);
		check(
			checks,
			'selecting a preset scopes the window',
			url.includes('mode=historic') && (chip ?? '').includes('→'),
			`${new URL(url).search} chip=${chip ?? 'none'}`,
		);

		await page.click('[data-testid="preset-15m"]');
		let completed = false;
		try {
			await page.waitForFunction(
				() =>
					document.querySelector('[data-testid="window-complete"]') !== null ||
					(document.querySelector('[data-testid="status-badge"]')?.textContent ?? '').includes(
						'ended',
					),
				undefined,
				{ timeout: options.timeout * 4 },
			);
			completed = true;
		} catch {
			completed = false;
		}
		check(checks, 'a 15 minute window finishes on its own', completed);

		await page.click('[data-testid="mode-live"]');
		await page.waitForTimeout(500);
		const backToLive = await page.getAttribute('[data-testid="mode-live"]', 'aria-pressed');
		check(checks, 'switching back to live restarts the tail', backToLive === 'true');

		// Every palette must switch without disrupting the log view or native controls.
		const themes = ['midnight', 'ocean', 'forest', 'plum', 'daylight', 'sand', 'mint', 'lavender'];
		check(
			checks,
			'eight colour themes available',
			(await page.getByTestId('theme-select').locator('option').count()) === themes.length,
		);
		for (const [index, theme] of themes.entries()) {
			await page.getByTestId('theme-select').selectOption(theme);
			const state = await page.evaluate(() => ({
				selected: document.documentElement.dataset.theme,
				scheme: getComputedStyle(document.documentElement).colorScheme,
				saved: localStorage.getItem('watch-tail:theme'),
			}));
			check(
				checks,
				`theme ${theme} applied and saved`,
				state.selected === theme &&
					state.saved === theme &&
					state.scheme === (index < 4 ? 'dark' : 'light'),
			);
		}
		await page.reload();
		await page.waitForFunction(
			() =>
				(document.querySelector('[data-testid="theme-select"]') as HTMLSelectElement | null)
					?.value === 'lavender',
		);
		check(
			checks,
			'theme restored after reload',
			(await page.getByTestId('theme-select').inputValue()) === 'lavender',
		);
		await page.getByTestId('theme-select').selectOption('midnight');

		// The reader can scale the interface: each step must grow the root font.
		const sizes = ['small', 'default', 'large', 'xlarge'];
		check(
			checks,
			'four text sizes available',
			(await page.getByTestId('text-size-select').locator('option').count()) === sizes.length,
		);
		let previousRootPx = 0;
		for (const size of sizes) {
			await page.getByTestId('text-size-select').selectOption(size);
			const state = await page.evaluate(() => ({
				selected: document.documentElement.dataset.textSize,
				saved: localStorage.getItem('watch-tail:text-size'),
				rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
			}));
			const grew = state.rootPx > previousRootPx;
			previousRootPx = state.rootPx;
			check(
				checks,
				`text size ${size} applied and saved`,
				state.selected === size && state.saved === size && grew,
				`${state.rootPx}px`,
			);
		}
		await page.reload();
		await page.waitForFunction(
			() =>
				(document.querySelector('[data-testid="text-size-select"]') as HTMLSelectElement | null)
					?.value === 'xlarge',
		);
		check(
			checks,
			'text size restored after reload',
			(await page.getByTestId('text-size-select').inputValue()) === 'xlarge',
		);
		await page.getByTestId('text-size-select').selectOption('default');

		// The group-list sidebar folds away to give the logs the full width.
		await page.waitForSelector('[data-testid="sidebar"]');
		const sidebarWasOpen =
			(await page.getAttribute('[data-testid="sidebar-toggle"]', 'aria-expanded')) === 'true';
		await page.click('[data-testid="sidebar-toggle"]');
		await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]') === null);
		const sidebarAfter = await page.evaluate(() => ({
			expanded: document
				.querySelector('[data-testid="sidebar-toggle"]')
				?.getAttribute('aria-expanded'),
			saved: localStorage.getItem('watch-tail:sidebar-open'),
		}));
		check(
			checks,
			'group sidebar collapses and is remembered',
			sidebarWasOpen && sidebarAfter.expanded === 'false' && sidebarAfter.saved === 'false',
		);
		await page.click('[data-testid="sidebar-toggle"]');
		await page.waitForSelector('[data-testid="sidebar"]');
		check(
			checks,
			'group sidebar expands again',
			(await page.getAttribute('[data-testid="sidebar-toggle"]', 'aria-expanded')) === 'true',
		);

		check(checks, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

		if (options.screenshot !== null) {
			await page.screenshot({ path: options.screenshot });
			console.log(`screenshot: ${options.screenshot}`);
		}
	} catch (error) {
		check(checks, 'browser run', false, error instanceof Error ? error.message : String(error));
	} finally {
		await browser?.close();
	}

	let failed = 0;
	for (const entry of checks) {
		if (!entry.ok) failed += 1;
		console.log(
			`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `  (${entry.detail})`}`,
		);
	}
	console.log(`${checks.length - failed}/${checks.length} checks passed`);
	return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
