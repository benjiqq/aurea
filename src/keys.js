import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { sha256 } from "./consensus.js";

const exportPrivateKey = (key) => key.export({ type: "pkcs8", format: "pem" });
const generatePrivateKey = () => generateKeyPairSync("ed25519").privateKey;
const keyHex = (key) => Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url").toString("hex");

export const isPublicKey = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isSignature = (value) => typeof value === "string" && /^[0-9a-f]{128}$/.test(value);
export const addressFromPublicKey = (publicKey) => sha256(Buffer.from(publicKey, "hex")).slice(0, 40);

export function loadNodeIdentity(databasePath, path = databasePath === ":memory:" ? null : databasePath + ".node-key.pem") {
  if (path === null) {
    const privateKey = generatePrivateKey();
    return { publicKey: keyHex(privateKey), privateKey };
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    privateKey = generatePrivateKey();
    const temporaryPath = path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporaryPath, exportPrivateKey(privateKey), { flag: "wx", mode: 0o600, flush: true });
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        privateKey = createPrivateKey(readFileSync(path));
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The node key must be an Ed25519 private key.");
  return { publicKey: keyHex(privateKey), privateKey };
}

export function generateWallet() {
  const privateKey = generatePrivateKey();
  const publicKey = keyHex(privateKey);
  const address = addressFromPublicKey(publicKey);
  return { address, publicKey, privateKey: exportPrivateKey(privateKey) };
}

export function signBlockHash(hash, privateKey) {
  return sign(null, Buffer.from(hash, "hex"), privateKey).toString("hex");
}

export function verifyBlockSigner(hash, publicKey, signature) {
  const x = Buffer.from(publicKey, "hex").toString("base64url");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return verify(null, Buffer.from(hash, "hex"), key, Buffer.from(signature, "hex"));
}
