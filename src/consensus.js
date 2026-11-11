import { createHash } from "node:crypto";

export const DIFFICULTY = 4;
const targetPrefix = "0".repeat(DIFFICULTY);
const workPerBlock = 16n ** BigInt(DIFFICULTY);

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const meetsTarget = (hash) => hash.startsWith(targetPrefix);
export const chainWork = (height) => BigInt(height) * workPerBlock;

export function blockHeader({ height, parent, timestamp, difficulty, transfer, minerPublicKey }) {
  const { sender, recipient, amount, nonce } = transfer;
  const fields = [height, parent, timestamp, difficulty, sender, recipient, amount, nonce];
  // Preserve the original header for blocks mined before attribution was added.
  return JSON.stringify(minerPublicKey === undefined
    ? ["aurea-pow-v1", ...fields]
    : ["aurea-pow-v2", ...fields, minerPublicKey]);
}

export function proofHash(header, proofNonce) {
  return sha256(header + "\n" + proofNonce);
}
