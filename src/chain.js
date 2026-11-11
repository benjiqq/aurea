import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { DIFFICULTY, blockHeader, chainWork, meetsTarget, proofHash, sha256 } from "./consensus.js";
import { addressFromPublicKey, isPublicKey, isSignature, loadNodeIdentity, signBlockHash, verifyBlockSigner } from "./keys.js";

const allocations = [["01".repeat(20), "100"], ["02".repeat(20), "100"]];
const genesis = {
  height: 0,
  timestamp: 0,
  hash: sha256(JSON.stringify(["aurea-genesis-v1", DIFFICULTY, allocations])),
};
const maxClockSkew = 120_000;

export const isAddress = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const isDecimal = (value) => typeof value === "string" && /^[0-9]{1,78}$/.test(value);

export class TransferError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function readTransfer(input) {
  if (!input || Object.keys(input).length !== 4 ||
      !isAddress(input.sender) || !isAddress(input.recipient) ||
      !isDecimal(input.amount) || !isDecimal(input.nonce)) {
    throw new TransferError("Provide sender, recipient, amount, and nonce. Amount and nonce must be decimal strings.");
  }

  const { sender, recipient } = input;
  const amount = BigInt(input.amount);
  const nonce = BigInt(input.nonce);
  if (sender === recipient) throw new TransferError("Choose a different recipient.");
  if (amount === 0n) throw new TransferError("Amount must be greater than zero.");
  return { sender, recipient, amount: amount.toString(), nonce: nonce.toString() };
}

function mine(header) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./miner.js", import.meta.url), { workerData: header });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("Miner exited before returning proof of work.")));
  });
}

class Ledger {
  constructor(blockSubsidy, tip = genesis, accounts = new Map(allocations.map(([address, balance]) => [
    address, { balance: BigInt(balance), nonce: 0n },
  ]))) {
    this.tip = tip;
    this.accounts = accounts;
    this.blockSubsidy = blockSubsidy;
  }

  #balance(address) {
    return this.accounts.get(address) ?? { balance: 0n, nonce: 0n };
  }

  account(address) {
    const { balance, nonce } = this.#balance(address);
    return { address, balance: balance.toString(), nonce: nonce.toString() };
  }

  checkTransfer(transfer) {
    const sender = this.#balance(transfer.sender);
    if (sender.nonce !== BigInt(transfer.nonce)) {
      throw new TransferError("Sender nonce changed. Check the account and try again.", 409);
    }
    if (sender.balance < BigInt(transfer.amount)) {
      throw new TransferError("Sender has insufficient balance.", 422);
    }
    return sender;
  }

  validateBlock(block, maxTimestamp = Number.MAX_SAFE_INTEGER) {
    const hasMiner = block && Object.hasOwn(block, "minerPublicKey");
    if (!block || Object.keys(block).length !== (hasMiner ? 9 : 7) ||
        (hasMiner && (!isPublicKey(block.minerPublicKey) || !isSignature(block.minerSignature))) ||
        !Number.isSafeInteger(block.height) || block.height !== this.tip.height + 1 ||
        block.parent !== this.tip.hash || block.difficulty !== DIFFICULTY ||
        !Number.isSafeInteger(block.timestamp) || block.timestamp <= this.tip.timestamp || block.timestamp > maxTimestamp ||
        !Number.isSafeInteger(block.proofNonce) || block.proofNonce < 0) {
      throw new Error("Invalid block header.");
    }
    const transfer = readTransfer(block.transfer);
    if (transfer.amount !== block.transfer.amount || transfer.nonce !== block.transfer.nonce ||
        block.hash !== proofHash(blockHeader(block), block.proofNonce) || !meetsTarget(block.hash)) {
      throw new Error("Invalid block proof or transfer encoding.");
    }
    if (hasMiner && !verifyBlockSigner(block.hash, block.minerPublicKey, block.minerSignature)) {
      throw new Error("Invalid block miner signature.");
    }

    const sender = this.checkTransfer(transfer);
    const recipient = this.#balance(transfer.recipient);
    const amount = BigInt(transfer.amount);
    const changes = new Map([
      [transfer.sender, { balance: sender.balance - amount, nonce: sender.nonce + 1n }],
      [transfer.recipient, { balance: recipient.balance + amount, nonce: recipient.nonce }],
    ]);
    if (hasMiner && this.blockSubsidy > 0n) {
      const address = addressFromPublicKey(block.minerPublicKey);
      const miner = changes.get(address) ?? this.#balance(address);
      changes.set(address, { balance: miner.balance + this.blockSubsidy, nonce: miner.nonce });
    }
    return changes;
  }

  apply(block, changes) {
    for (const [address, account] of changes) this.accounts.set(address, account);
    this.tip = block;
  }
}

export class Chain {
  #ledger;
  #mining;
  #db;
  #append;
  #recent;
  #blockAt;
  #range;
  #deleteSuffix;
  #identity;
  #blockSubsidy;

  constructor(path, { keyPath, blockSubsidy } = {}) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`
        PRAGMA locking_mode = EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      `);
      const savedSubsidy = this.#db.prepare("SELECT value FROM settings WHERE name = 'block_subsidy'").get();
      const subsidy = blockSubsidy ?? savedSubsidy?.value ?? "1";
      if (!isDecimal(subsidy)) throw new Error("AUREA_BLOCK_SUBSIDY must be a nonnegative decimal integer.");
      this.#blockSubsidy = BigInt(subsidy);
      if (savedSubsidy && savedSubsidy.value !== this.blockSubsidy) {
        throw new Error("AUREA_BLOCK_SUBSIDY differs from the saved ledger setting. Reset the ledger to change it.");
      }
      this.#db.prepare("INSERT OR IGNORE INTO blocks VALUES (0, ?)").run(JSON.stringify(genesis));
      const storedGenesis = this.#db.prepare("SELECT body FROM blocks WHERE height = 0").get();
      if (storedGenesis.body !== JSON.stringify(genesis)) throw new Error("Database genesis does not match Aurea PoW v1.");

      this.#range = this.#db.prepare("SELECT height, body FROM blocks WHERE height BETWEEN ? AND ? ORDER BY height LIMIT ?");
      this.#blockAt = this.#db.prepare("SELECT body FROM blocks WHERE height = ?");
      this.#append = this.#db.prepare("INSERT INTO blocks VALUES (?, ?)");
      this.#deleteSuffix = this.#db.prepare("DELETE FROM blocks WHERE height > ?");
      this.#recent = this.#db.prepare("SELECT body FROM blocks WHERE height > 0 ORDER BY height DESC LIMIT 20");
      const { lowest, highest } = this.#db.prepare("SELECT MIN(height) AS lowest, MAX(height) AS highest FROM blocks").get();
      if (lowest !== 0) throw new Error("Stored chain has an invalid height.");
      this.#ledger = this.#replay(highest);
      this.#identity = loadNodeIdentity(path, keyPath);
      this.#db.prepare("INSERT OR IGNORE INTO settings VALUES ('block_subsidy', ?)").run(this.blockSubsidy);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #replay(through) {
    const ledger = new Ledger(this.#blockSubsidy);
    for (const { height, body } of this.#range.iterate(1, through, -1)) {
      try {
        const block = JSON.parse(body);
        if (height !== block.height) throw new Error("Stored height does not match block.");
        ledger.apply(block, ledger.validateBlock(block));
      } catch (error) {
        throw new Error("Invalid stored block at height " + height, { cause: error });
      }
    }
    if (ledger.tip.height !== through) throw new Error("Stored chain has a missing block.");
    return ledger;
  }

  account(address) {
    return this.#ledger.account(address);
  }

  get tip() {
    const { height, hash } = this.#ledger.tip;
    return { height, hash };
  }

  get genesisHash() {
    return genesis.hash;
  }

  get publicKey() {
    return this.#identity.publicKey;
  }

  get blockSubsidy() {
    return this.#blockSubsidy.toString();
  }

  hashAt(height) {
    const row = this.#blockAt.get(height);
    return row && JSON.parse(row.body).hash;
  }

  blocks(from, through, limit) {
    return this.#range.all(from, through, limit).map(({ body }) => JSON.parse(body));
  }

  status() {
    return {
      tip: this.tip,
      chain_work: chainWork(this.#ledger.tip.height).toString(),
      mining: Boolean(this.#mining),
      difficulty: DIFFICULTY,
      block_subsidy: this.blockSubsidy,
      recent_blocks: this.#recent.all().map(({ body }) => JSON.parse(body)),
    };
  }

  async adoptBranch(ancestor, tip, batches) {
    if (chainWork(tip.height) <= chainWork(this.#ledger.tip.height) ||
        this.hashAt(ancestor.height) !== ancestor.hash) return false;

    const ledger = ancestor.height === this.#ledger.tip.height
      ? new Ledger(this.#blockSubsidy, this.#ledger.tip, new Map(this.#ledger.accounts))
      : this.#replay(ancestor.height);
    const blocks = [];
    for await (const batch of batches) {
      for (const block of batch) {
        ledger.apply(block, ledger.validateBlock(block, Date.now() + maxClockSkew));
        blocks.push(block);
      }
    }
    if (ledger.tip.height !== tip.height || ledger.tip.hash !== tip.hash) {
      throw new Error("Branch does not reach its advertised tip.");
    }

    // Local mining or another peer may have advanced the chain during download.
    if (chainWork(ledger.tip.height) <= chainWork(this.#ledger.tip.height) ||
        this.hashAt(ancestor.height) !== ancestor.hash) return false;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#deleteSuffix.run(ancestor.height);
      for (const block of blocks) this.#append.run(block.height, JSON.stringify(block));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#ledger = ledger;
    return true;
  }

  async submit(input) {
    if (this.#mining) throw new TransferError("The node is mining another transfer. Try again shortly.", 409);

    const transfer = readTransfer(input);
    this.#ledger.checkTransfer(transfer);
    try {
      const parent = this.#ledger.tip;
      const timestamp = Math.max(Date.now(), parent.timestamp + 1);
      if (timestamp > Date.now() + maxClockSkew) {
        throw new TransferError("The chain tip is ahead of the local clock. Try again shortly.", 409);
      }
      const candidate = {
        height: parent.height + 1,
        parent: parent.hash,
        timestamp,
        difficulty: DIFFICULTY,
        transfer,
        minerPublicKey: this.publicKey,
      };
      this.#mining = mine(blockHeader(candidate));
      const block = { ...candidate, ...await this.#mining };
      if (parent.hash !== this.#ledger.tip.hash) {
        throw new TransferError("The chain tip changed while mining. Check the account and try again.", 409);
      }
      block.minerSignature = signBlockHash(block.hash, this.#identity.privateKey);
      const changes = this.#ledger.validateBlock(block);
      this.#append.run(block.height, JSON.stringify(block));
      this.#ledger.apply(block, changes);
      return { height: block.height, hash: block.hash, account: this.account(transfer.sender) };
    } finally {
      this.#mining = undefined;
    }
  }

  async close() {
    await this.#mining?.catch(() => {});
    this.#db.close();
  }
}
