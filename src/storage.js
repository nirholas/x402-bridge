// Channel storage directory for the batch-settlement scheme.
//
// FileClientChannelStorage writes one JSON per channel into `{root}/client/`.
// We pin the root at `~/.x402-mcp-bridge/channels` so the bridge survives
// Claude Desktop restarts — the second call to a batch endpoint reads the
// voucher state written by the first, instead of redepositing.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getChannelsDirectory() {
	const override = process.env.X402_MCP_BRIDGE_CHANNELS_DIR;
	const root = override && override.trim() ? override : join(homedir(), '.x402-mcp-bridge', 'channels');
	mkdirSync(join(root, 'client'), { recursive: true });
	return root;
}
