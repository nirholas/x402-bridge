// Tests for the pre-payment spending-cap hook (buildSpendingCapHook).
//
// The hook captures its caps from env at build time, but the cumulative
// session accumulator is module state shared across hooks — so the scenarios
// below run in ONE sequential test, tracking exactly how much each accepted
// payment adds, and rebuild the hook per env scenario.
//
// All addresses/assets are clearly-synthetic placeholders — no real mints or
// wallets appear in fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSpendingCapHook } from '../src/x402-axios-client.js';

const SYNTH_ASSET = `0x${'a'.repeat(40)}`;
const SYNTH_PAYEE = `0x${'b'.repeat(40)}`;
const SYNTH_OTHER_PAYEE = `0x${'c'.repeat(40)}`;

// payTo is intentionally NOT defaulted: passing `payTo: undefined` must reach
// the hook as a genuinely missing payee so the allowlist's missing-payee branch
// is exercised. Defaulting here would silently substitute an allowlisted payee.
function requirements({ amount, payTo = SYNTH_PAYEE, omitPayTo = false }) {
	return {
		selectedRequirements: {
			amount: String(amount),
			network: 'eip155:8453',
			asset: SYNTH_ASSET,
			payTo: omitPayTo ? undefined : payTo,
		},
	};
}

async function withEnv(overrides, fn) {
	const saved = {};
	for (const k of Object.keys(overrides)) {
		saved[k] = process.env[k];
		if (overrides[k] === undefined) delete process.env[k];
		else process.env[k] = overrides[k];
	}
	try {
		return await fn();
	} finally {
		for (const k of Object.keys(overrides)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

const BASE_ENV = {
	MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC: undefined,
	MCP_BRIDGE_MAX_TOTAL_ATOMIC: undefined,
	MCP_BRIDGE_ALLOWED_PAYTO: undefined,
};

test('spending-cap hook: per-call cap, payee allowlist, session ceiling', async (t) => {
	// Running total of session spend this process has accepted, mirrored by
	// every accepted payment below. The module accumulator starts at 0 because
	// this file is its own test process.
	let spent = 0n;

	await t.test('accepts a payment within the default per-call cap', async () => {
		await withEnv(BASE_ENV, async () => {
			const hook = buildSpendingCapHook();
			const verdict = await hook(requirements({ amount: 1_000 }));
			assert.equal(verdict, undefined, 'in-cap payment must not be aborted');
			spent += 1_000n;
		});
	});

	await t.test('aborts above the per-call cap with an actionable reason', async () => {
		await withEnv(BASE_ENV, async () => {
			const hook = buildSpendingCapHook();
			const verdict = await hook(requirements({ amount: 100_001 })); // default cap is 100_000
			assert.equal(verdict.abort, true);
			assert.match(verdict.reason, /payment refused/);
			assert.match(verdict.reason, /100001 exceeds per-call cap 100000/);
			assert.match(verdict.reason, /MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC/, 'must name the override var');
			assert.match(verdict.reason, /network=eip155:8453/);
			assert.match(verdict.reason, new RegExp(`asset=${SYNTH_ASSET}`));
		});
	});

	await t.test('honors a lowered per-call cap from env', async () => {
		await withEnv({ ...BASE_ENV, MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC: '500' }, async () => {
			const hook = buildSpendingCapHook();
			const refused = await hook(requirements({ amount: 501 }));
			assert.equal(refused.abort, true);
			assert.match(refused.reason, /exceeds per-call cap 500/);

			const allowed = await hook(requirements({ amount: 500 }));
			assert.equal(allowed, undefined, 'cap is inclusive');
			spent += 500n;
		});
	});

	await t.test('payee allowlist refuses unlisted payees, case-insensitively', async () => {
		await withEnv(
			{ ...BASE_ENV, MCP_BRIDGE_ALLOWED_PAYTO: SYNTH_PAYEE.toUpperCase() },
			async () => {
				const hook = buildSpendingCapHook();
				const refused = await hook(requirements({ amount: 100, payTo: SYNTH_OTHER_PAYEE }));
				assert.equal(refused.abort, true);
				assert.match(refused.reason, new RegExp(`payee "${SYNTH_OTHER_PAYEE}"`));
				assert.match(refused.reason, /MCP_BRIDGE_ALLOWED_PAYTO/);

				const missing = await hook(requirements({ amount: 100, omitPayTo: true }));
				assert.equal(missing.abort, true, 'a missing payTo must not bypass the allowlist');

				const allowed = await hook(requirements({ amount: 100, payTo: SYNTH_PAYEE }));
				assert.equal(allowed, undefined, 'allowlisted payee accepted (case-insensitive)');
				spent += 100n;
			},
		);
	});

	await t.test('session ceiling aborts, names the running total, and is inclusive', async () => {
		const ceiling = spent + 200n;
		await withEnv({ ...BASE_ENV, MCP_BRIDGE_MAX_TOTAL_ATOMIC: ceiling.toString() }, async () => {
			const hook = buildSpendingCapHook();

			const refused = await hook(requirements({ amount: 201 }));
			assert.equal(refused.abort, true);
			assert.match(refused.reason, /would exceed session spend cap/);
			assert.match(refused.reason, new RegExp(`already spent ${spent}`));
			assert.match(refused.reason, /MCP_BRIDGE_MAX_TOTAL_ATOMIC/, 'must name the override var');

			const exact = await hook(requirements({ amount: 200 }));
			assert.equal(exact, undefined, 'spend up to exactly the ceiling is allowed');
			spent += 200n;

			const over = await hook(requirements({ amount: 1 }));
			assert.equal(over.abort, true, 'any further spend after the ceiling is refused');
		});
	});

	await t.test('aborted payments never count toward the session total', async () => {
		// Ceiling exactly one unit above what has actually been spent: if any of
		// the aborted calls above had been (incorrectly) accumulated, this would refuse.
		await withEnv(
			{ ...BASE_ENV, MCP_BRIDGE_MAX_TOTAL_ATOMIC: (spent + 1n).toString() },
			async () => {
				const hook = buildSpendingCapHook();
				const verdict = await hook(requirements({ amount: 1 }));
				assert.equal(verdict, undefined);
				spent += 1n;
			},
		);
	});
});
