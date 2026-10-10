// EVM and SVM signer factories for the bridge.
//
// EVM: viem account from `MCP_BRIDGE_EVM_PRIVATE_KEY` (0x-prefixed 32-byte hex).
//      We attach a viem PublicClient so the extension-enrichment paths
//      (EIP-2612 permit, ERC-20 approval) can read on-chain state — required
//      for Permit2 endpoints that opt into gas sponsoring.
//
// SVM: @solana/kit KeyPairSigner from `MCP_BRIDGE_SVM_PRIVATE_KEY`. Accepts
//      either a base58-encoded 64-byte secret key (the format Phantom and
//      `solana-keygen` print) or a JSON array of 64 integers (the format
//      `~/.config/solana/id.json` stores). The 64 bytes are the secret-key
//      pair: 32-byte private seed followed by 32-byte public key.
//
// Both functions throw with an explicit message naming the missing env var
// the first time a network is needed. They return `null` if the env is unset,
// so the caller can decide whether to fail fast or skip that network.

import bs58 from 'bs58';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, publicActions, createWalletClient } from 'viem';
import { base, baseSepolia, mainnet, polygon, arbitrum } from 'viem/chains';
import { toClientEvmSigner } from '@x402/evm';

const VIEM_CHAIN_BY_ID = new Map(
	[mainnet, base, baseSepolia, polygon, arbitrum].map((c) => [c.id, c]),
);

function rpcUrlFor(chainId) {
	const explicit = process.env[`RPC_URL_${chainId}`];
	if (explicit) return explicit;
	return undefined;
}

export function getEvmSigner({ chainId } = {}) {
	const key = process.env.MCP_BRIDGE_EVM_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
	if (!key) return null;
	const normalized = key.startsWith('0x') ? key : `0x${key}`;
	const account = privateKeyToAccount(normalized);

	// Pick a chain for the publicClient. Default to Base mainnet — the
	// extension-enrichment readContract calls only matter for assets on the
	// chain we're actually paying on, and Base is the dominant x402 EVM chain.
	const chain = (chainId && VIEM_CHAIN_BY_ID.get(chainId)) || base;
	const transport = http(rpcUrlFor(chain.id));
	const publicClient = createPublicClient({ chain, transport });
	const walletClient = createWalletClient({ account, chain, transport }).extend(publicActions);

	// `toClientEvmSigner` composes the optional readContract / nonce / fee
	// helpers off the public client onto the account so Permit2 flows work.
	return toClientEvmSigner(walletClient, publicClient);
}

function decodeSvmSecretKey(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith('[')) {
		const arr = JSON.parse(trimmed);
		if (!Array.isArray(arr) || arr.length !== 64) {
			throw new Error('MCP_BRIDGE_SVM_PRIVATE_KEY JSON must be a 64-element byte array');
		}
		return Uint8Array.from(arr);
	}
	const bytes = bs58.decode(trimmed);
	if (bytes.length !== 64) {
		throw new Error(
			`MCP_BRIDGE_SVM_PRIVATE_KEY decoded to ${bytes.length} bytes, expected 64 (secret-key pair).`,
		);
	}
	return bytes;
}

export async function getSvmSigner() {
	const raw = process.env.MCP_BRIDGE_SVM_PRIVATE_KEY || process.env.SVM_PRIVATE_KEY;
	if (!raw) return null;
	const bytes = decodeSvmSecretKey(raw);
	return createKeyPairSignerFromBytes(bytes);
}
