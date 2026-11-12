// Create a funded testnet master account through NEAR's public faucet helper,
// then top it up by creating throw-away faucet accounts and deleting them into the master.
// Keys are written to sim/.near-credentials/workspaces/testnet (git-ignored). Testnet only.
import { KeyPair, keyStores, accountCreator, connect } from 'near-api-js';
import path from 'node:path';

const HELPER = process.env.HELPER_URL ?? 'https://helper.testnet.near.org';
const NODE = 'https://rpc.testnet.fastnear.com';
const ks = new keyStores.UnencryptedFileSystemKeyStore(path.join(process.cwd(), '.near-credentials', 'workspaces'));
const creator = new accountCreator.UrlAccountCreator({}, HELPER);
const near = await connect({ networkId: 'testnet', nodeUrl: NODE, keyStore: ks });
const rand = () => Math.random().toString(36).slice(2, 8);
const bal = async (id) => Number(BigInt((await (await near.account(id)).getAccountBalance()).total) / 10n ** 21n) / 1000;

const master = process.env.TESTNET_MASTER_ACCOUNT_ID ?? `spendtree-${rand()}.testnet`;
if (!(await ks.getKey('testnet', master))) {
  const kp = KeyPair.fromRandom('ed25519');
  await creator.createAccount(master, kp.getPublicKey());
  await ks.setKey('testnet', master, kp);
  console.log('created', master);
}
const target = Number(process.env.TARGET_NEAR ?? 25);
for (let i = 0; i < 6 && (await bal(master)) < target; i++) {
  const tmp = `tmp-${rand()}.testnet`;
  const kp = KeyPair.fromRandom('ed25519');
  await creator.createAccount(tmp, kp.getPublicKey());
  await ks.setKey('testnet', tmp, kp);
  await (await near.account(tmp)).deleteAccount(master);
  await ks.removeKey('testnet', tmp);
  console.log('topped up via', tmp);
}
console.log(`MASTER=${master} balance=${await bal(master)} NEAR`);
