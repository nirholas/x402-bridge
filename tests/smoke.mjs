// Smoke test for the MCP stdio bridge.
//
// Launches src/index.js as a subprocess with a generated test signer (no
// real funds at risk — the bridge never tries to settle, we only exercise
// the start-up path, tool listing, and the spending-cap abort).
//
// Test flow:
//   1. Boot the bridge, send initialize/tools/list — assert call_paid_endpoint,
//      list_bazaar_tools, refresh_bazaar exist + at least one paid_* dynamic tool.
//   2. Call call_paid_endpoint on a real x402-paid resource with
//      MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC=1 — assert the response carries
//      the cap-exceeded error string.
//   3. Re-launch the bridge and confirm ~/.x402-mcp-bridge/channels exists
//      (storage directory survives restart). The channel file itself only
//      writes after a real settlement, so we only assert the directory.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

let nextId = 1;
function frame(method, params) {
	return JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) + '\n';
}

async function withBridge(env, run) {
	const child = spawn('node', [join(import.meta.dirname, '..', 'src', 'index.js')], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...env },
	});

	let stdoutBuf = '';
	let stderrBuf = '';
	const pending = new Map();

	child.stdout.on('data', (chunk) => {
		stdoutBuf += chunk.toString('utf8');
		let nl;
		while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
			const line = stdoutBuf.slice(0, nl);
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id && pending.has(msg.id)) {
				const { resolve } = pending.get(msg.id);
				pending.delete(msg.id);
				resolve(msg);
			}
		}
	});
	child.stderr.on('data', (chunk) => {
		stderrBuf += chunk.toString('utf8');
	});

	const send = (method, params) => {
		const json = frame(method, params);
		const id = JSON.parse(json).id;
		const p = new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error(`timeout waiting for ${method}#${id}`));
				}
			}, 30_000);
		});
		child.stdin.write(json);
		return p;
	};

	try {
		await send('initialize', {
			protocolVersion: '2025-03-26',
			clientInfo: { name: 'smoke', version: '0.0.1' },
			capabilities: {},
		});
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
		return await run({ send, getStderr: () => stderrBuf });
	} finally {
		child.kill('SIGTERM');
		await new Promise((r) => child.once('exit', r));
	}
}

function assert(cond, msg) {
	if (!cond) {
		console.error('FAIL:', msg);
		process.exit(1);
	} else {
		console.log('PASS:', msg);
	}
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'x402-bridge-smoke-'));
const channelsDir = join(tmpRoot, 'channels');

const env = {
	// Burner EVM key so the bridge can boot. We never make real settlements
	// in this test, just exercise the start-up + cap-abort paths.
	MCP_BRIDGE_EVM_PRIVATE_KEY: generatePrivateKey(),
	MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC: '1', // 1 atomic unit = effectively zero
	MCP_BRIDGE_DISCOVER_LIMIT: '5',
	X402_MCP_BRIDGE_CHANNELS_DIR: channelsDir,
};

try {
	await withBridge(env, async ({ send }) => {
		const tools = await send('tools/list', {});
		const names = (tools.result?.tools || []).map((t) => t.name);
		console.log('  registered tools:', names.slice(0, 8).join(', '), '…');
		assert(names.includes('call_paid_endpoint'), 'call_paid_endpoint registered');
		assert(names.includes('list_bazaar_tools'), 'list_bazaar_tools registered');
		assert(names.includes('refresh_bazaar'), 'refresh_bazaar registered');
		assert(names.some((n) => n.startsWith('paid_')), 'at least one dynamic paid_* tool');

		// Spending-cap check: call any real x402-paid endpoint with cap=1.
		// The bridge SHOULD return an isError tool result mentioning the cap.
		// We pick one of the discovered tools so the URL is guaranteed live.
		const dynamicTool = (tools.result?.tools || []).find((t) => t.name.startsWith('paid_'));
		const resourceUrl = dynamicTool ? dynamicTool.description.match(/Resource: (\S+)/)?.[1] : null;
		assert(!!resourceUrl, 'extracted resource URL from a dynamic tool description');

		const call = await send('tools/call', {
			name: 'call_paid_endpoint',
			arguments: { url: resourceUrl, method: 'GET' },
		});
		const text =
			call.result?.content?.map((c) => c.text || '').join('\n') ||
			call.error?.message ||
			JSON.stringify(call);
		assert(call.result?.isError === true, 'call_paid_endpoint returned isError for cap-blocked call');
		assert(
			/exceeds spending cap|cap (1|of)/i.test(text) || /aborted/i.test(text),
			'error text mentions the spending cap',
		);
	});

	// Second boot: prove the channels directory survives.
	await withBridge(env, async ({ send }) => {
		await send('tools/list', {});
	});
	assert(existsSync(channelsDir), 'channels directory persists across bridge restarts');
	assert(existsSync(join(channelsDir, 'client')), 'channels/client subdir created by FileClientChannelStorage');
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('\nAll smoke checks passed.');
