import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Chain } from "../src/chain.js";
import { blockHeader, chainWork, meetsTarget, proofHash } from "../src/consensus.js";
import { addressFromPublicKey, loadNodeIdentity, signBlockHash } from "../src/keys.js";

const alice = "01".repeat(20);
const bob = "02".repeat(20);
const carol = "03".repeat(20);
const transfer = (sender, recipient, amount, nonce = "0") => ({ sender, recipient, amount, nonce });

async function* batches(...pages) {
  yield* pages;
}

test("equal work keeps the tip, greater work replaces the fork and persists its balances", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aurea-test-"));
  const path = join(directory, "aurea.sqlite3");
  let local = new Chain(path);
  const peer = new Chain(":memory:");
  t.after(async () => {
    await local.close();
    await peer.close();
    await rm(directory, { recursive: true, force: true });
  });

  const genesis = local.tip;
  await local.submit(transfer(alice, bob, "10"));
  const common = local.tip;
  await peer.adoptBranch(genesis, common, batches(local.blocks(1, 1, 1)));
  await local.submit(transfer(alice, carol, "15", "1"));
  const oldTip = local.tip;
  const localMiner = addressFromPublicKey(local.publicKey);
  const peerMiner = addressFromPublicKey(peer.publicKey);
  assert.equal(local.account(localMiner).balance, "2");
  await peer.submit(transfer(bob, carol, "20"));

  assert.equal(await local.adoptBranch(common, peer.tip, batches(peer.blocks(2, 2, 1))), false);
  assert.deepEqual(local.tip, oldTip);
  assert.equal(local.account(carol).balance, "15");

  await peer.submit(transfer(alice, bob, "5", "1"));
  assert.equal(await local.adoptBranch(common, peer.tip, batches(peer.blocks(2, 2, 1), peer.blocks(3, 3, 1))), true);
  assert.deepEqual(local.tip, peer.tip);
  assert.deepEqual(local.blocks(1, 3, 3).map((block) => block.minerPublicKey), [
    local.publicKey, peer.publicKey, peer.publicKey,
  ]);
  assert.equal(local.status().chain_work, chainWork(3).toString());
  assert.deepEqual(local.account(alice), { address: alice, balance: "85", nonce: "2" });
  assert.deepEqual(local.account(bob), { address: bob, balance: "95", nonce: "1" });
  assert.equal(local.account(carol).balance, "20");
  assert.equal(local.account(localMiner).balance, "1");
  assert.equal(local.account(peerMiner).balance, "2");

  const publicKey = local.publicKey;
  await local.close();
  local = new Chain(path);
  assert.equal(local.publicKey, publicKey);
  assert.deepEqual(local.status(), peer.status());
  assert.deepEqual(local.account(bob), peer.account(bob));
  assert.equal(local.account(localMiner).balance, "1");
  assert.equal(local.account(peerMiner).balance, "2");
});

test("a configured subsidy credits the miner after each transfer and preserves its nonce", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aurea-subsidy-"));
  const path = join(directory, "aurea.sqlite3");
  const chain = new Chain(path, { blockSubsidy: "3" });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const miner = addressFromPublicKey(chain.publicKey);
  try {
    await assert.rejects(chain.submit(transfer(miner, bob, "1")), /insufficient balance/);
    await chain.submit(transfer(alice, miner, "5"));
    assert.deepEqual(chain.account(miner), { address: miner, balance: "8", nonce: "0" });
    await chain.submit(transfer(miner, bob, "8"));
    assert.deepEqual(chain.account(miner), { address: miner, balance: "3", nonce: "1" });
  } finally {
    await chain.close();
  }
  const restored = new Chain(path);
  try {
    assert.equal(restored.blockSubsidy, "3");
    assert.deepEqual(restored.account(miner), { address: miner, balance: "3", nonce: "1" });
  } finally {
    await restored.close();
  }
  assert.throws(() => new Chain(path, { blockSubsidy: "4" }), /differs from the saved ledger setting/);
});

test("a failed proof leaves the entire candidate branch uncommitted", async (t) => {
  const local = new Chain(":memory:");
  const peer = new Chain(":memory:");
  t.after(() => Promise.all([local.close(), peer.close()]));

  const genesis = local.tip;
  await peer.submit(transfer(alice, bob, "10"));
  await peer.submit(transfer(bob, alice, "5"));
  const [first, second] = peer.blocks(1, 2, 2);
  const fakeSignature = "00".repeat(64);

  await assert.rejects(local.adoptBranch(genesis, peer.tip, batches([first], [
    { ...second, minerSignature: fakeSignature },
  ])), /Invalid block miner signature/);
  await assert.rejects(local.adoptBranch(genesis, peer.tip, batches([first], [
    { ...second, minerPublicKey: local.publicKey },
  ])), /Invalid block proof/);
  assert.deepEqual(local.tip, genesis);
  assert.deepEqual(local.account(alice), { address: alice, balance: "100", nonce: "0" });
  assert.deepEqual(local.blocks(1, 2, 2), []);
});

test("a branch must still have more work after it finishes downloading", async (t) => {
  const local = new Chain(":memory:");
  const peer = new Chain(":memory:");
  t.after(() => Promise.all([local.close(), peer.close()]));

  const genesis = local.tip;
  await peer.submit(transfer(alice, bob, "10"));

  async function* delayedBlocks() {
    yield peer.blocks(1, 1, 1);
    await local.submit(transfer(bob, alice, "1"));
  }

  assert.equal(await local.adoptBranch(genesis, peer.tip, delayedBlocks()), false);
  assert.equal(local.account(alice).balance, "101");
  assert.equal(local.account(bob).nonce, "1");
});

test("a downloaded branch is discarded if another reorg replaces its ancestor", async (t) => {
  const local = new Chain(":memory:");
  const candidate = new Chain(":memory:");
  const winner = new Chain(":memory:");
  t.after(() => Promise.all([local.close(), candidate.close(), winner.close()]));

  const genesis = local.tip;
  await local.submit(transfer(alice, bob, "10"));
  const ancestor = local.tip;
  await candidate.adoptBranch(genesis, ancestor, batches(local.blocks(1, 1, 1)));
  await candidate.submit(transfer(alice, carol, "5", "1"));
  await candidate.submit(transfer(alice, carol, "5", "2"));
  await winner.submit(transfer(bob, alice, "1"));
  await winner.submit(transfer(bob, alice, "1", "1"));

  async function* delayedBlocks() {
    yield candidate.blocks(2, 2, 1);
    assert.equal(await local.adoptBranch(genesis, winner.tip, batches(winner.blocks(1, 2, 2))), true);
    yield candidate.blocks(3, 3, 1);
  }

  assert.equal(await local.adoptBranch(ancestor, candidate.tip, delayedBlocks()), false);
  assert.deepEqual(local.tip, winner.tip);
  assert.deepEqual(local.blocks(1, 3, 3), winner.blocks(1, 2, 2));
  assert.equal(local.account(alice).balance, "102");
  assert.equal(local.account(addressFromPublicKey(candidate.publicKey)).balance, "0");
});

test("valid proof and signature cannot authorize an overspend on a longer branch", async (t) => {
  const local = new Chain(":memory:");
  const source = new Chain(":memory:");
  t.after(() => Promise.all([local.close(), source.close()]));

  const genesis = local.tip;
  await local.submit(transfer(bob, alice, "1"));
  await source.submit(transfer(alice, bob, "80"));
  const [first] = source.blocks(1, 1, 1);
  const { publicKey, privateKey } = loadNodeIdentity(":memory:");
  const second = {
    height: 2,
    parent: first.hash,
    timestamp: first.timestamp + 1,
    difficulty: first.difficulty,
    transfer: transfer(alice, carol, "21", "1"),
    minerPublicKey: publicKey,
  };
  const header = blockHeader(second);
  let proofNonce = 0;
  let hash = proofHash(header, proofNonce);
  while (!meetsTarget(hash)) hash = proofHash(header, ++proofNonce);
  Object.assign(second, { proofNonce, hash, minerSignature: signBlockHash(hash, privateKey) });

  const original = local.status();
  await assert.rejects(
    local.adoptBranch(genesis, { height: 2, hash }, batches([first], [second])),
    /insufficient balance/,
  );
  assert.deepEqual(local.status(), original);
  assert.deepEqual(local.account(alice), { address: alice, balance: "101", nonce: "0" });
  assert.equal(local.account(addressFromPublicKey(source.publicKey)).balance, "0");
});

test("mining on a replaced parent cannot commit a stale block", async (t) => {
  const local = new Chain(":memory:");
  const peer = new Chain(":memory:");
  t.after(() => Promise.all([local.close(), peer.close()]));

  const genesis = local.tip;
  await peer.submit(transfer(bob, alice, "5"));
  const rejected = assert.rejects(local.submit(transfer(alice, bob, "10")), /tip changed while mining/);
  assert.equal(await local.adoptBranch(genesis, peer.tip, batches(peer.blocks(1, 1, 1))), true);
  await rejected;
  assert.deepEqual(local.tip, peer.tip);
  assert.equal(local.account(alice).nonce, "0");
  assert.equal(local.account(alice).balance, "105");
});
