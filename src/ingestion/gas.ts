import { getTransactionReceipt, getBlock, type TxReceipt } from './alchemy.js';
import { fetchSentTransactions } from './blockscout.js';
import type { TxRow, EventRow } from './normalize.js';

export type GasItem = { tx: TxRow; event: EventRow; receipt: TxReceipt };

// A fee is its own ETH outflow from the sender. It has no counterparty, so to_address is
// NULL and it never looks like a payment to the contract that was called.
function gasItem(receipt: TxReceipt, walletAddress: string, blockTime: Date): GasItem {
  const amount = Number(receipt.fee) / 1e18;
  return {
    receipt,
    tx: {
      wallet_id: '',
      chain: 'base',
      hash: receipt.hash,
      block_number: receipt.blockNumber,
      block_time: blockTime,
      from_address: walletAddress,
      to_address: receipt.to,
      asset: 'ETH',
      amount: 0,
      usd_value: null,
      gas_used: Number(receipt.gasUsed),
      gas_price: Number(receipt.effectiveGasPrice) / 1e9,
      gas_usd: null,
      direction: 'out',
      tx_type: 'contract_call',
      raw_payload: receipt.raw,
    },
    event: {
      wallet_id: '',
      user_id: '',
      chain: 'base',
      hash: receipt.hash,
      log_index: null,
      source_key: 'gas',
      token_address: null,
      supported: true,
      raw_amount: receipt.fee.toString(),
      block_number: receipt.blockNumber,
      category: 'gas',
      block_time: blockTime,
      from_address: walletAddress,
      to_address: null,
      asset: 'ETH',
      amount,
      usd_value: null,
      price_source: null,
      price_at: null,
      direction: 'out',
    },
  };
}

async function receiptsFor(
  apiKey: string,
  walletAddress: string,
  txs: Array<{ hash: string; blockTime: Date }>,
): Promise<GasItem[]> {
  const wallet = walletAddress.toLowerCase();
  const items: GasItem[] = [];
  for (const t of txs) {
    const receipt = await getTransactionReceipt(apiKey, t.hash);
    // Not mined yet, or paid by someone else (e.g. a sponsored smart-wallet call)
    if (!receipt || receipt.from.toLowerCase() !== wallet) continue;
    items.push(gasItem(receipt, walletAddress, t.blockTime));
  }
  return items;
}

// Gas for every transaction the wallet sent in the range, found through Blockscout's
// sent-transaction list (which, unlike transfer feeds, includes failed transactions and
// calls that move no tokens), with fees from Alchemy receipts.
export async function fetchGasItems(
  apiKey: string,
  walletAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<GasItem[]> {
  const sent = await fetchSentTransactions(walletAddress, fromBlock, toBlock);
  return receiptsFor(apiKey, walletAddress, sent.map((t) => ({ hash: t.hash, blockTime: new Date(t.timestamp) })));
}

// Repair path: read the block itself, so a transaction any indexer missed is still found.
export async function fetchGasItemsForBlock(
  apiKey: string,
  walletAddress: string,
  blockNumber: number,
): Promise<GasItem[]> {
  const block = await getBlock(apiKey, blockNumber, true);
  if (!block) return [];
  const wallet = walletAddress.toLowerCase();
  const blockTime = new Date(block.timestamp * 1000);
  return receiptsFor(
    apiKey,
    walletAddress,
    block.transactions
      .filter((t) => t.from.toLowerCase() === wallet)
      .map((t) => ({ hash: t.hash, blockTime })),
  );
}
