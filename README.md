# Aurea Node

A local proof-of-work chain in Node.js. 

## Run locally

Requires Node.js 22.13 or newer and npm. From this directory:

```sh
npm ci
npm run build
npm start
```

Open [the explorer](http://127.0.0.1:8080). **Overview** shows chain and peer
status. In **Transfers**, select **Use demo accounts** to prepare a transfer.
Each demo account starts with 100 units. In **Blocks**, expand a block to see
its parent, nonces, and the mining node's public key. Older blocks show **Unknown**.

The default node and the launch scripts store signing keys under `secrets/` as
`<database filename>.node-key.pem`. Set `AUREA_NODE_KEY` to override the key path.
When you set `AUREA_DB` manually without a key path, the key lives beside that
database.
The proof of work commits to the public key and peers verify the node's
signature over the block hash.

**Wallets** shows the miner account and lets you look up any address. Select
**Generate wallet** to create a random Ed25519 keypair and look up its new
address. Open **Show private key** to save the PEM key. Generated wallets are
returned once and do not receive a starting balance. Transfers on this demo
are unsigned.

The server listens on loopback. Transfers are unsigned, so anyone with local
access to the node can spend from any funded account. Each transfer produces one
block. A worker searches for a nonce that makes the SHA-256 block hash start
with four hexadecimal zeros. The node checks the proof, parent, height, amount,
balance, and sender nonce before committing the block.

The chain uses its own genesis and block format. SQLite saves blocks in
`data/aurea.sqlite3` by default. The node verifies and replays them at startup. Set `PORT` or `AUREA_DB` to change the HTTP port or
database path. Use a separate database for each process.

The header shows the node's public key. The miner's account address and
balance appear below it. Every signed block credits a subsidy to the address
derived from the signing miner's public key. The miner can spend the subsidy
after the block is accepted. Replaying older signed blocks also credits the
subsidy. Select
**Fund miner** to prepare a transfer from a demo account to the miner. Review
the sender and amount before submitting. To spend that balance, select
**Send from miner**, enter a recipient and amount, and submit the transfer.

## Run two peers

Run both peers from this directory after installing dependencies:

```sh
./start.sh
```

Open [node A](http://127.0.0.1:8081) and [node B](http://127.0.0.1:8082).
Send a demo transfer on either node and watch the other catch up. The script
builds the explorer and reuses each miner's key file. Use `./stop.sh` from
another terminal to stop both peers. Use `./start.sh --standalone` and
`./stop.sh --standalone` for the node on port 8080. Run `./stop.sh --all` to
stop the peer pair and the standalone node together.

To start over, stop the nodes and run `./reset.sh`. The script uses
`lsof` to check that the databases and ports are free, archives the peer
ledgers under `data/.aurea-reset/`, and restarts from genesis with the same miner
keys. Use `./reset.sh --standalone` for the standalone ledger.
At genesis each demo account has 100 units and miner balances start at 0.

Set `AUREA_BLOCK_SUBSIDY` to a nonnegative whole number of units. The default
is 1. All peers on a network must use the same amount. The database remembers
its subsidy so that restart and replay use the same ledger rules. To change
the amount, set it when resetting the chain.

```sh
AUREA_BLOCK_SUBSIDY=3 ./reset.sh
```

For manual startup, `AUREA_PEERS` accepts comma-separated loopback HTTP origins.
Each node polls its configured peers about once a second.

### Fork choice

Every valid non-genesis block contributes 65,536 units of work at the fixed
four-zero target. Nodes keep their current tip on a tie. When a peer has more
work, the node finds the last shared block, verifies the peer's branch in
batches, and checks that its work still beats the local chain. Incoming block
timestamps can be up to two minutes ahead of the local clock.

The node replaces the losing suffix in one SQLite transaction and publishes the
winning branch's balances and nonces. A displaced transfer can be submitted
again if it is absent from the winning branch. A miner whose parent changed during
the search discards its result and returns a conflict so the sender can retry.

## HTTP API

- `GET /api/status` returns the tip, cumulative work, difficulty, block subsidy, miner state,
  node public key, miner account, configured peer status, and the 20 latest blocks.
- `POST /api/wallets` generates a random Ed25519 keypair and returns
  `address`, `publicKey` (hex), and `privateKey` (PKCS#8 PEM).
- `GET /api/accounts/<address>` returns a balance and the next transfer nonce.
- `POST /api/transfers` accepts a JSON object with `sender`, `recipient`,
  `amount`, and `nonce`. Addresses are 40 lowercase hex characters. Amounts
  and nonces are decimal strings. A successful response contains the mined
  block's height and hash, along with the updated sender account.
- Peer requests send `X-Aurea-Peer-Rules: aurea-block-subsidy-v1`.
- `GET /api/peer/tip` returns the genesis hash, active tip, rules version,
  and configured block subsidy.
- `GET /api/peer/blocks?from=1&through=5&anchor=<hash>&limit=32` returns up to 32
  active blocks in ascending order. The anchor is the active block hash at
  `through`. A changed anchor returns HTTP 409.

Run `npm test` for the fork choice, validation, and mining race tests.
