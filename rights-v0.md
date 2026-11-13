# Aurea V0: PoW-earned mining rights

This prototype adds a mining-rights registry, deterministic producer selection, and
fork choice by cumulative proof of work. Run it locally from the JS node directory:

```sh
node src/simulate-rights-v0.js
node src/simulate-rights-v0.js --offline
npm test
```

The simulator uses the node's hashing and Ed25519 helpers with an in-memory ledger
and fixed difficulty of two leading zero hex digits. It has its own genesis and
block format. It does not use the node's database, transactions, or peers.

1. **Earn rights with PoW.** Each accepted PoW block, including fallback blocks,
   creates one nontransferable credit. Its ID is the block hash and its owner is
   the miner's public key. A credit earned at height `h` is eligible for the 100
   heights in `[h + 10, h + 110)`. Winning a slot does not spend the credit.
2. **Schedule rights blocks.** Heights with `height % 10 === 9` are rights slots
   (9, 19, 29, and so on); other heights require PoW. Sort eligible credits by
   hash and index the list with the SHA-256 draw modulo its length. The draw
   commits to the parent hash and next height. Each credit is one entry, so a
   miner can have more than one chance. The winner signs a hash that commits to
   the block's height, parent, timestamp, kind, and miner key. A rights block
   needs no PoW and creates no credit.
3. **Keep PoW authoritative.** Every valid PoW block adds 256 units of chainwork.
   A rights block adds zero. Replay candidate chains from genesis to reconstruct
   credits and work. Replace the current branch only if the candidate has more
   verified work; keep the current branch on a tie.

If no credit is eligible, PoW is allowed immediately. Otherwise, a rights block
must have a timestamp strictly before the parent's timestamp plus 10 simulated
ticks. At or after that boundary, only PoW is allowed. All timestamps must
increase. This is a deterministic rule for the simulator, not a real-time waiting
guarantee: a miner controls its block timestamp and can jump ahead. Parent hashes
can also be influenced by miners. Production timing and seed manipulation are
outside V0.

The first rights slot falls before any credit activates, so the default 100-block
run produces 91 PoW blocks and 9 rights blocks with all miners online. The offline
run exercises fallback at every rights slot.

Later work: transaction fees with 80% paid to the miner and 20% to a treasury,
equivocation penalties, and experiments comparing 100/0, 90/10, and 51/49 slot
schedules. Measure the expected income per earned credit, the work needed to
rewrite 100 blocks, and whether spending shifts toward competition for PoW slots.
