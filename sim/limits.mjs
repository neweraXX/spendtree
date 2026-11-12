// Edge-case test: deep trees and refunds that race a revoke.
// 1) A chain of MAX_DEPTH (8) delegations works; a 9th level is rejected.
// 2) The deepest agent pays a missing account while, at the same moment, the branch above it is
//    revoked. If the revoke lands before the transfer's callback, the refund walks up 7 frozen
//    ancestors to the first active one. Either way: no reservation may stay stuck and the books
//    must still balance.
import assert from 'node:assert/strict';
import { connect, keyStores } from 'near-api-js';
import { createWorld, N, fmt, GAS } from './world.mjs';

const names = Array.from({ length: 10 }, (_, i) => `a${i}`); // a0 is the root
const W = await createWorld({ names, budget: 10 });
const acc = W.accounts;
try {
  // 1) chain a0 -> a1 -> ... -> a8 (depth 8), 1 NEAR less at each level
  for (let i = 0; i < 8; i++) {
    await acc[`a${i}`].call(W.contract, 'delegate', { child: acc[`a${i + 1}`].accountId, amount: N(9 - i).toString() });
  }
  let tooDeep = '';
  try {
    await acc.a8.call(W.contract, 'delegate', { child: acc.a9.accountId, amount: N(0.5).toString() });
  } catch (e) {
    tooDeep = String(e);
  }
  assert.match(tooDeep, /delegation tree too deep/, 'a 9th level must be rejected');
  console.log('depth cap: 9th level rejected (delegation tree too deep)');

  // 2) a8 pays a missing account; concurrently a0 revokes a1 (freezing a1..a8).
  const nodeUrl = W.worker.provider.connection.url;
  const signer = async (a) => {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey('sandbox', a.accountId, await a.getKey());
    return (await connect({ networkId: 'sandbox', nodeUrl, keyStore })).account(a.accountId);
  };
  const [s8, s0] = await Promise.all([signer(acc.a8), signer(acc.a0)]);
  const results = await Promise.allSettled([
    s8.functionCall({ contractId: W.contract.accountId, methodName: 'pay', args: { recipient: `nobody-${Date.now()}.test.near`, amount: N(0.5).toString() }, gas: GAS }),
    s0.functionCall({ contractId: W.contract.accountId, methodName: 'revoke', args: { child: acc.a1.accountId }, gas: GAS }),
  ]);
  const events = await W.view('get_events');
  const order = events.slice(-4).map((e) => e.kind).join(' > ');
  console.log('event order:', order, '| pay tx:', results[0].status, '| revoke tx:', results[1].status);

  const tree = await W.view('get_tree');
  const totals = await W.view('get_totals');
  const stuck = tree.filter((n) => BigInt(n.reserved) > 0n);
  assert.equal(stuck.length, 0, 'no reservation may stay stuck');
  assert.equal(totals.conserved, true, 'books must balance');
  const root = tree.find((n) => n.account === acc.a0.accountId);
  console.log(`root available ${fmt(root.available)} NEAR (all 10 back after the refund), conserved=${totals.conserved}`);
  assert.equal(BigInt(root.available), N(10), 'the failed 0.5 NEAR and the revoked branch must all return to the root');
  const refundAfterRevoke = order.indexOf('revoke') !== -1 && order.indexOf('revoke') < order.indexOf('pay_refunded');
  console.log(refundAfterRevoke ? 'refund landed AFTER the revoke: walked up the frozen chain to a0' : 'refund landed before the revoke (race went the other way)');
  // 3) Widest possible branch: a1 gets 62 children (tree full at 64 nodes), then ONE revoke freezes all 63.
  //    Children are just ids in the contract; they do not need to exist as accounts.
  const W2 = await createWorld({ names: ['b0', 'b1'], budget: 10 });
  try {
    await W2.accounts.b0.call(W2.contract, 'delegate', { child: W2.accounts.b1.accountId, amount: N(9).toString() });
    for (let i = 0; i < 62; i++) {
      await W2.accounts.b1.call(W2.contract, 'delegate', { child: `kid${i}.test.near`, amount: N(0.1).toString() });
    }
    let full = '';
    try {
      await W2.accounts.b1.call(W2.contract, 'delegate', { child: 'one-too-many.test.near', amount: N(0.1).toString() });
    } catch (e) {
      full = String(e);
    }
    assert.match(full, /tree is full/, '65th agent must be rejected');
    const res = await W2.accounts.b0.callRaw(W2.contract, 'revoke', { child: W2.accounts.b1.accountId }, { gas: 300_000_000_000_000n });
    assert.ok(res.succeeded, 'revoking a full-width branch must fit in one transaction');
    const burnt = res.outcomes.reduce((s, o) => s + BigInt(o.gas_burnt), 0n);
    const t2 = await W2.view('get_totals');
    assert.equal(t2.conserved, true);
    console.log(`full tree (64 agents): 65th rejected; one revoke froze 63 agents using ${Number(burnt / 10n ** 12n)} Tgas of the 300 Tgas limit`);
  } finally {
    await W2.worker.tearDown();
  }
  console.log('LIMITS TEST PASSED');
} finally {
  await W.worker.tearDown();
}
