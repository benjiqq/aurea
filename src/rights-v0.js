import { proofHash, sha256 } from "./consensus.js";
import { isPublicKey, isSignature, signBlockHash, verifyBlockSigner } from "./keys.js";

export const config = Object.freeze({
  powSlots: 9,
  rightsSlots: 1,
  activationDelay: 10,
  rightsLifetime: 100,
  fallbackDelay: 10,
  difficulty: 2,
});

const workPerPoW = 16n ** BigInt(config.difficulty);
const meetsTarget = (hash) => hash.startsWith("0".repeat(config.difficulty));
const genesis = Object.freeze({
  height: 0,
  timestamp: 0,
  hash: sha256(JSON.stringify(["aurea-rights-v0-genesis", config])),
});

export function slotType(height) {
  // Position 9 in each ten-height cycle is reserved for a rights producer.
  return height % (config.powSlots + config.rightsSlots) >= config.powSlots ? "RIGHTS" : "POW";
}

function header({ height, parent, timestamp, kind, minerPublicKey }) {
  // Both block kinds hash these fields in the same fixed order.
  return JSON.stringify(["aurea-rights-v0", height, parent, timestamp, kind, minerPublicKey]);
}

export class RightsChain {
  #blocks = [genesis];
  #rights = new Map();
  #chainWork = 0n;

  get tip() { return this.#blocks.at(-1); }
  get chainWork() { return this.#chainWork; }
  get blocks() { return [...this.#blocks]; }

  activeRights(height = this.tip.height + 1) {
    // Activation is inclusive and expiration is exclusive.
    return [...this.#rights.values()].filter((right) =>
      right.activeFrom <= height && height < right.expiresAt
    );
  }

  selectedMiner() {
    // A null winner lets PoW proceed immediately, including at startup
    // when a rights slot arrives before any credit has activated.
    const height = this.tip.height + 1;
    if (slotType(height) !== "RIGHTS") return null;
    // Sort by block hash so replay produces the same ordering. Each credit
    // gets its own entry, even when several belong to the same miner.
    const rights = this.activeRights(height).sort((a, b) => a.id < b.id ? -1 : 1);
    if (!rights.length) return null;
    // The committed parent hash and next height fix the draw before the
    // candidate is built. BigInt preserves all 256 bits until the modulo.
    const draw = BigInt("0x" + sha256(JSON.stringify(["aurea-rights-v0-draw", this.tip.hash, height])));
    return rights[Number(draw % BigInt(rights.length))].owner;
  }

  // The caller supplies the miner and block kind. Time advances by one
  // simulated tick by default, or by a caller-supplied amount for fallback.
  produce({ publicKey, privateKey }, { kind = "POW", timestamp = this.tip.timestamp + 1 } = {}) {
    const block = { height: this.tip.height + 1, parent: this.tip.hash, timestamp, kind, minerPublicKey: publicKey };
    const encoded = header(block);
    if (kind === "POW") {
      // Try nonces against the fixed target while keeping the header stable.
      let proofNonce = 0;
      let hash = proofHash(encoded, proofNonce);
      while (!meetsTarget(hash)) hash = proofHash(encoded, ++proofNonce);
      Object.assign(block, { proofNonce, hash });
    } else {
      // Rights blocks hash the header once. Eligibility comes from the draw.
      block.hash = sha256(encoded);
    }
    // Both kinds sign the resulting hash. Local blocks go through the same
    // validation as blocks received for branch replay.
    block.minerSignature = signBlockHash(block.hash, privateKey);
    return this.append(block);
  }

  append(input) {
    const block = { ...input };
    const pow = block.kind === "POW";
    const isRights = block.kind === "RIGHTS";
    if ((!pow && !isRights) || Object.keys(block).length !== (pow ? 8 : 7) ||
        !Number.isSafeInteger(block.height) || block.height !== this.tip.height + 1 ||
        block.parent !== this.tip.hash || !Number.isSafeInteger(block.timestamp) ||
        block.timestamp <= this.tip.timestamp || !isPublicKey(block.minerPublicKey) ||
        !isSignature(block.minerSignature) || (isRights && Object.hasOwn(block, "proofNonce"))) {
      throw new Error("Invalid block header.");
    }

    const winner = this.selectedMiner();
    const encoded = header(block);
    // With a winner, the parent timestamp plus the delay is the first tick
    // that accepts fallback PoW and the first tick that rejects rights blocks.
    if (pow) {
      if (winner !== null && block.timestamp - this.tip.timestamp < config.fallbackDelay) {
        throw new Error("PoW fallback is too early.");
      }
      if (!Number.isSafeInteger(block.proofNonce) || block.proofNonce < 0 ||
          block.hash !== proofHash(encoded, block.proofNonce) || !meetsTarget(block.hash)) {
        throw new Error("Invalid proof of work.");
      }
    } else {
      if (winner === null || block.minerPublicKey !== winner) throw new Error("Wrong rights miner or slot.");
      if (block.timestamp - this.tip.timestamp >= config.fallbackDelay) throw new Error("Rights slot timed out.");
      if (block.hash !== sha256(encoded)) throw new Error("Invalid rights block hash.");
    }
    if (!verifyBlockSigner(block.hash, block.minerPublicKey, block.minerSignature)) {
      throw new Error("Invalid miner signature.");
    }

    // Only validated PoW earns a new credit and increases chainwork.
    if (pow) {
      const activeFrom = block.height + config.activationDelay;
      this.#rights.set(block.hash, Object.freeze({
        id: block.hash,
        owner: block.minerPublicKey,
        activeFrom,
        expiresAt: activeFrom + config.rightsLifetime,
      }));
      this.#chainWork += workPerPoW;
    }
    this.#blocks.push(Object.freeze(block));
    return this.tip;
  }

  adoptBranch(blocks) {
    // Replay into a fresh ledger so the candidate earns its own credits and
    // chainwork. Install its state only after validation and a strict work win.
    const candidate = new RightsChain();
    if (blocks[0]?.height !== 0 || blocks[0]?.hash !== genesis.hash) throw new Error("Wrong genesis.");
    for (const block of blocks.slice(1)) candidate.append(block);
    if (candidate.chainWork <= this.chainWork) return false;

    this.#blocks = candidate.#blocks;
    this.#rights = candidate.#rights;
    this.#chainWork = candidate.#chainWork;
    return true;
  }
}
