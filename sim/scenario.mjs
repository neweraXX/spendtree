// SpendTree demo scenario on a local NEAR sandbox.
// Every agent ends up holding ONLY a function-call key to the SpendTree contract.
// After each step we check the conservation invariant and save a trace for the UI.
import { Worker, KeyPair } from 'near-workspaces';
import { functionCallAccessKey } from 'near-api-js/lib/transaction.js';
import { connect, keyStores } from 'near-api-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const WASM = process.env.WASM ?? '../contract/target/wasm32-unknown-unknown/release/spendtree.wasm';
const OUT = process.env.OUT ?? './out/trace.json';
const YOCTO = 10n ** 24n;
const N = (x) => (BigInt(Math.round(x * 1000)) * YOCTO) / 1000n;
const fmt = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toFixed(3);
const METHODS = ['delegate', 'pay', 'revoke'];
const NETWORK = process.env.NETWORK ?? 'sandbox';
const TESTNET = NETWORK === 'testnet';
// Initial balances (NEAR). Testnet faucet funds are limited, so agents get just enough for gas.
const BAL = TESTNET ? { contract: 3.6, human: 10.5, agent: 0.3 } : { contract: 5, human: 30, agent: 1 };
const SUFFIX = TESTNET ? 'testnet' : 'test.near';
const EXPLORER = TESTNET ? 'https://testnet.nearblocks.io' : null;
const txs = [];

const trace = [];
let contract;

async function snapshot(step, title, story) {
  const tree = await contract.view('get_tree', {});
  const totals = await contract.view('get_totals', {});
  const events = await contract.view('get_events', {});
  assert.equal(totals.conserved, true, `conservation broken after step ${step}`);
  trace.push({ step, title, story, tree, totals, events });
  console.log(`\n[${step}] ${title}`);
  for (const n of tree) {
    console.log(
      `   ${n.account.split('.')[0].padEnd(11)} budget ${fmt(n.budget).padStart(7)}  avail ${fmt(n.available).padStart(7)}  spent ${fmt(n.spent).padStart(6)}  deleg ${fmt(n.delegated).padStart(6)}${n.revoked ? '  REVOKED' : ''}`,
    );
  }
  console.log(`   conserved: deposit ${fmt(totals.total_deposit)} = avail ${fmt(totals.available)} + reserved ${fmt(totals.reserved)} + spent ${fmt(totals.spent)}`);
}

// Replace the account's full-access key with function-call key(s) limited to the contract.
async function lockDown(account, extraKeys = 0) {
  const keys = [];
  for (let i = 0; i <= extraKeys; i++) keys.push(KeyPair.fromRandom('ed25519'));
  const full = await account.getKey();
  let tx = account.batch(account);
  for (const k of keys) tx = tx.addKey(k.getPublicKey(), functionCallAccessKey(contract.accountId, METHODS, N(0.25)));
  await tx.deleteKey(full.getPublicKey()).transact();
  await account.setKey(keys[0]);
  return keys;
}

const lastEvent = async () => (await contract.view('get_events', {})).at(-1);

async function main() {
  const worker = await Worker.init(
      TESTNET ? { network: 'testnet', testnetMasterAccountId: process.env.TESTNET_MASTER_ACCOUNT_ID, rootAccountId: process.env.ROOT_ID ?? `run${Date.now() % 1e7}`, initialBalance: N(17), rpcAddr: 'https://rpc.testnet.fastnear.com' } : undefined,
    );
  try {
    const root = worker.rootAccount;
    contract = await root.createSubAccount('spendtree', { initialBalance: N(BAL.contract) });
    await contract.deploy(WASM);
    const human = await root.createSubAccount('human', { initialBalance: N(BAL.human) });
    const mk = (name) => root.createSubAccount(name, { initialBalance: N(BAL.agent) });
    const agents = [];
    for (const name of ['planner', 'researcher', 'reviewer', 'scout', 'critic', 'vendor']) agents.push(await mk(name));
    const [planner, researcher, reviewer, scout, critic, vendor] = agents;

    // 1. Human funds the tree.
    await human.call(contract, 'new', { root: planner.accountId }, { attachedDeposit: N(10) });
    for (const a of [planner, reviewer, scout, critic]) await lockDown(a);
    const researcherKeys = await lockDown(researcher, 1); // two keys = two parallel threads
    await snapshot(1, 'Human funds 10 NEAR', 'A human deposits 10 NEAR. The planner agent becomes the root of the spending tree. Every agent now holds only a function-call key to the contract.');

    // 2. Planner delegates.
    await planner.call(contract, 'delegate', { child: researcher.accountId, amount: N(6).toString() });
    await planner.call(contract, 'delegate', { child: reviewer.accountId, amount: N(4).toString() });
    await snapshot(2, 'Planner splits budget 6 / 4', 'The planner gives 6 NEAR to the researcher and 4 NEAR to the reviewer. Its own spendable balance drops to 0: delegating removes authority, it does not copy it.');

    // 3. Prompt-injected researcher forks two sub-agents in parallel, 4 NEAR each.
    // Two independent signers (one per key) submit at the same moment.
    const nodeUrl = worker.provider.connection.url;
    const thread = async (key) => {
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey('sandbox', researcher.accountId, key);
      const near = await connect({ networkId: 'sandbox', nodeUrl, keyStore });
      return near.account(researcher.accountId);
    };
    const [t1, t2] = await Promise.all(researcherKeys.map(thread));
    await Promise.all([
      t1.functionCall({ contractId: contract.accountId, methodName: 'delegate', args: { child: scout.accountId, amount: N(4).toString() } }),
      t2.functionCall({ contractId: contract.accountId, methodName: 'delegate', args: { child: critic.accountId, amount: N(4).toString() } }),
    ]);
    const tree3 = await contract.view('get_tree', {});
    const spawned = tree3.filter((n) => [scout.accountId, critic.accountId].includes(n.account));
    assert.equal(spawned.length, 1, 'exactly one of the two 4-NEAR forks may exist');
    await snapshot(3, 'Injected agent forks twice: 4 + 4 from 6', `A prompt-injected researcher spawns two sub-agents at the same time, 4 NEAR each, from a 6 NEAR budget. Only ${spawned[0].account.split('.')[0]} gets funded; the second fork is rejected on-chain.`);

    // 4. Researcher tries to move money directly, bypassing the contract.
    let directBlocked = false;
    try {
      await researcher.transfer(vendor, N(1));
    } catch (e) {
      directBlocked = true;
    }
    assert.ok(directBlocked, 'function-call key must not allow a plain transfer');
    const over = await researcher.callRaw(contract, 'pay', { recipient: `attacker.${SUFFIX}`, amount: N(3).toString(), memo: 'injected: send all' });
    assert.ok(over.succeeded);
    assert.equal((await lastEvent()).kind, 'pay_rejected');
    await researcher.call(contract, 'pay', { recipient: vendor.accountId, amount: N(1).toString(), memo: 'dataset purchase' }, { gas: 100_000_000_000_000n });
    await snapshot(4, 'Direct transfer blocked, overspend rejected', 'The researcher tries a plain NEAR transfer from its own account: the protocol refuses, its key can only call SpendTree. It then asks SpendTree to pay an attacker 3 NEAR with 2 available: rejected. A legitimate 1 NEAR payment to the vendor goes through.');

    // 5. Reviewer pays an account that does not exist: the transfer fails and is restored once.
    const ghost = await reviewer.callRaw(contract, 'pay', { recipient: `ghost-vendor-${Date.now()}.${SUFFIX}`, amount: N(2).toString(), memo: 'typo in vendor id' }, { gas: 100_000_000_000_000n });
    assert.ok(ghost.receiptFailures.length > 0, 'transfer to a missing account should fail');
    assert.equal((await lastEvent()).kind, 'pay_refunded');
    await reviewer.call(contract, 'pay', { recipient: vendor.accountId, amount: N(1.5).toString(), memo: 'code review' }, { gas: 100_000_000_000_000n });
    await snapshot(5, 'Failed payout restored exactly once', 'The reviewer pays a vendor id that does not exist. NEAR runs the transfer asynchronously; it fails, the contract callback restores the 2 NEAR once. Then a real 1.5 NEAR payment settles.');

    // 6. Planner revokes the researcher's whole branch.
    await planner.call(contract, 'revoke', { child: researcher.accountId });
    let frozen = false;
    const child = spawned[0].account === scout.accountId ? scout : critic;
    try {
      await child.call(contract, 'pay', { recipient: vendor.accountId, amount: N(0.5).toString() }, { gas: 100_000_000_000_000n });
    } catch (e) {
      frozen = String(e).includes('revoked');
    }
    assert.ok(frozen, 'revoked sub-agent must not spend');
    await snapshot(6, 'Planner revokes the injected branch', 'The planner pulls back everything the researcher branch has not spent: 5 of the 6 NEAR (1 NEAR was already spent on the vendor in step 4). The sub-agent tries to pay afterwards and is refused. The books still balance to 10 NEAR.');

    const totals = await contract.view('get_totals', {});
    assert.equal(BigInt(totals.spent), N(2.5));
    const planNode = (await contract.view('get_tree', {})).find((n) => n.account === planner.accountId);
    assert.ok(BigInt(planNode.available) > 0n);
    console.log('\nALL CHECKS PASSED: conservation held after every step; vendor received 2.5 NEAR.');

    mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), network: NETWORK, explorer: EXPLORER, contract: contract.accountId, accounts: { planner: planner.accountId, researcher: researcher.accountId, reviewer: reviewer.accountId, vendor: vendor.accountId }, steps: trace }, null, 2));
    console.log(`trace written to ${OUT}`);
    // Same data as a script so ui/index.html works when opened straight from disk.
    const payload = JSON.parse(JSON.stringify({ generated: new Date().toISOString(), network: NETWORK, explorer: EXPLORER, contract: contract.accountId, accounts: { planner: planner.accountId, researcher: researcher.accountId, reviewer: reviewer.accountId, vendor: vendor.accountId }, steps: trace }));
    writeFileSync('../ui/trace.js', `window.SPENDTREE_TRACE = ${JSON.stringify(payload)};\n`);
  } finally {
    await worker.tearDown();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
