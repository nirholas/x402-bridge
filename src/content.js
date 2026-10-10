// MCP tool-result content builders, shared by every bridge tool.

/**
 * Wrap a value as an MCP tool result. Everything goes out as a JSON `text`
 * block (universally consumable); plain objects ALSO go out as
 * `structuredContent` so typed clients can skip re-parsing the text. MCP
 * requires structuredContent to be an object, so strings/arrays stay text-only.
 */
export function asTextContent(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	const result = { content: [{ type: 'text', text }] };
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		result.structuredContent = value;
	}
	return result;
}

export function asErrorContent(message) {
	return {
		isError: true,
		content: [{ type: 'text', text: message }],
	};
}
