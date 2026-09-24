/**
 * The stdio transport loop for the MCP server.
 *
 * tmcp owns the protocol (initialization, capabilities, argument validation,
 * tool dispatch); this loop only frames messages: newline-delimited JSON-RPC in,
 * one JSON response line out. It is written here rather than using
 * `@tmcp/transport-stdio` because that transport calls `process.exit()` itself,
 * which would tear the process down before the private watch-tail server it
 * proxies could be stopped gracefully.
 *
 * stdout carries the protocol and nothing else; diagnostics go to stderr, which
 * the caller owns.
 */

/** Writable side of the transport (process.stdout, or a test double). */
export type McpOutput = {
	write(chunk: string): boolean | void;
	once?(event: 'drain', listener: () => void): unknown;
};

/** The slice of tmcp's `McpServer` the loop drives. */
type McpReceiver = {
	receive(message: unknown, context?: unknown): Promise<unknown> | unknown;
};

/** Everything {@link serveMcp} needs. */
export type ServeMcpOptions = {
	/** Readable side (process.stdin, or a test double). */
	input: AsyncIterable<Buffer | string>;
	output: McpOutput;
	/** The tmcp server whose messages are being served. */
	server: McpReceiver;
	/** Called for a message that could not be handled; never fatal. */
	onError?: (error: unknown) => void;
};

/** A JSON-RPC parse error, sent for a line that is not JSON. */
const PARSE_ERROR_RESPONSE = JSON.stringify({
	jsonrpc: '2.0',
	id: null,
	error: { code: -32_700, message: 'Parse error' },
});

/**
 * The fields the protocol defines for an `InitializeResult`.
 *
 * tmcp builds the initialize result by spreading the server options it was
 * constructed with, so its own `adapter` (a class instance) is carried along and
 * serialised as `{}`. It is an internal detail, not part of the protocol, so a
 * response to `initialize` is narrowed to the fields a client may expect.
 */
const INITIALIZE_RESULT_KEYS = [
	'protocolVersion',
	'capabilities',
	'serverInfo',
	'instructions',
	'_meta',
];

/** True for a JSON object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows an `initialize` response to its protocol fields.
 *
 * Any other response is returned untouched; this exists only because tmcp leaks
 * its own options into that one result.
 */
export function sanitizeInitializeResponse(response: unknown): unknown {
	if (!isRecord(response) || !isRecord(response.result)) return response;
	const result: Record<string, unknown> = {};
	for (const key of INITIALIZE_RESULT_KEYS) {
		if (key in response.result) result[key] = response.result[key];
	}
	return { ...response, result };
}

/** Writes one line, waiting for the stream to drain when it is backed up. */
async function write(output: McpOutput, text: string): Promise<void> {
	const accepted = output.write(text);
	if (accepted === false && typeof output.once === 'function') {
		await new Promise<void>((resolveDrain) => output.once?.('drain', resolveDrain));
	}
}

/** Decodes and answers one line. */
async function handleLine(line: string, options: ServeMcpOptions): Promise<void> {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		await write(options.output, `${PARSE_ERROR_RESPONSE}\n`);
		return;
	}
	const response = await options.server.receive(message, { sessionInfo: {} });
	if (response === undefined || response === null) return;
	const isInitialize = isRecord(message) && message.method === 'initialize';
	await write(
		options.output,
		`${JSON.stringify(isInitialize ? sanitizeInitializeResponse(response) : response)}\n`,
	);
}

/**
 * Serves MCP messages until the input closes.
 *
 * Messages are handled in order, so replies come back in the order the client
 * sent the calls.
 */
export async function serveMcp(options: ServeMcpOptions): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of options.input) {
		buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf('\n');
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				await handleLine(line, options).catch((error) => options.onError?.(error));
			}
			newline = buffer.indexOf('\n');
		}
	}
	buffer += decoder.decode();
	const rest = buffer.trim();
	if (rest.length > 0) await handleLine(rest, options).catch((error) => options.onError?.(error));
}
