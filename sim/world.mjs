// Shared setup: start a NEAR network (local sandbox or testnet), deploy SpendTree,
// create agent accounts that hold ONLY a function-call key to the contract.
import { Worker, KeyPair } from 'near-workspaces';
import { functionCallAccessKey } from 'near-api-js/lib/transaction.js';

export const YOCTO = 10n ** 24n;
export const N = (x) => (BigInt(Math.round(Number(x) * 1000)) * YOCTO) / 1000n;
export const fmt = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toFixed(3);
export const METHODS = ['delegate', 'pay', 'revoke'];
export const GAS = 100_000_000_000_000n;

export async function createWorld({ names, budget = 10, attackerFunded = true }) {
  const network = process.env.NETWORK ?? 'sandbox';
  const testnet = network === 'testnet';
  const bal = testnet ? { contract: 3.6, human: budget + 0.5, agent: 0.3 } : { contract: 5, human: budget + 20, agent: 1 };
  const worker = await Worker.init(
    testnet
      ? {
          network: 'testnet',
          testnetMasterAccountId: process.env.TESTNET_MASTER_ACCOUNT_ID,
          rootAccountId: process.env.ROOT_ID ?? `run${Date.now() % 1e7}`,
          initialBalance: N(bal.contract + bal.human + bal.agent * (names.length + 2) + 1),
          rpcAddr: 'https://rpc.testnet.fastnear.com',
        }
      : undefined,
  );
  const root = worker.rootAccount;
  const contract = await root.createSubAccount('spendtree', { initialBalance: N(bal.contract) });
  await contract.deploy(process.env.WASM ?? '../contract/target/wasm32-unknown-unknown/release/spendtree.wasm');
  const human = await root.createSubAccount('human', { initialBalance: N(bal.human) });
  const accounts = {};
  for (const name of names) accounts[name] = await root.createSubAccount(name, { initialBalance: N(bal.agent) });
  // Payees: a legit vendor and the attacker's collector account (both real, so payments settle).
  const vendor = await root.createSubAccount('vendor', { initialBalance: N(bal.agent) });
  const collector = attackerFunded ? await root.createSubAccount('collector', { initialBalance: N(bal.agent) }) : null;

  await human.call(contract, 'new', { root: accounts[names[0]].accountId }, { attachedDeposit: N(budget) });
  for (const name of names) await lockDown(accounts[name], contract);

  const view = (m, a = {}) => contract.view(m, a);
  return { worker, network, testnet, contract, human, accounts, vendor, collector, view };
}

// Replace the full-access key with a function-call key that can only call SpendTree.
export async function lockDown(account, contract) {
  const key = KeyPair.fromRandom('ed25519');
  const full = await account.getKey();
  await account
    .batch(account)
    .addKey(key.getPublicKey(), functionCallAccessKey(contract.accountId, METHODS, N(0.25)))
    .deleteKey(full.getPublicKey())
    .transact();
  await account.setKey(key);
  return key;
}
