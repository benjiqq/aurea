# Aurea - Proof of concept

Aurea explores whether a blockchain can separate the competition for mining rights from day-to-day block production. The proposed hybrid schedules 51% of block opportunities for miners who earn temporary rights through proof of work (PoW) and 49% for ordinary PoW miners. Ordinary PoW blocks confirm rights-produced blocks and determine which chain nodes follow.

The proof of concept examines how the hybrid would allocate rights, handle missed slots, and settle competing histories. It also compares auctions, delayed rewards, and separate issuance as ways to change how miners compete for rewards.

## 1. The economics of conventional PoW

Suppose a blockchain distributes $10 million annually in block rewards and fees.

Miners compete for these rewards. As additional miners enter, difficulty increases until marginal mining profitability approaches their required return.

In a mature competitive equilibrium:

\\[ \text{Mining revenue}\approx\text{Mining costs}+\text{normal profit} \\]

| Annual economics              | Conventional PoW |
| ----------------------------- | ---------------- |
| Mining rewards + fees         | $10M             |
| Electricity                   | $5M              |
| Hardware depreciation         | $3M              |
| Infrastructure and operations | $1M              |
| Miner economic profit         | $1M              |

The figures illustrate one possible cost structure.

Mining expenditure purchases resistance to chain reorganization and double-spending.

The economic question is whether $9M of annual expenditure produces $9M of marginal security value. Often it may not.

Blockchain security is a collective benefit, but mining competition is privately optimized. The market does not automatically select a socially optimal security budget.

## 2. What a mining right grants

Imagine a blockchain where miners must obtain a right to mine before participating.

Depending on the design, a mining right can grant one or more of the following.

- Permission to produce blocks during a particular epoch.
- A fraction of the epoch's block-production opportunities.
- A claim on future block rewards.
- A transferable asset that can be sold or leased.

## 3. Model A — Auctioned mining rights

Miners bid for the right to produce blocks. The example below compares illustrative annual costs. Each model provides different security guarantees.

| Model | Annual physical expenditure |
| --- | ---: |
| Conventional PoW | $9M in competitive mining expenses |
| Auctioned mining rights | $1M in operating expenses |

If the auction raises $8M, that money can be burned, returned to a treasury, or redistributed to token holders.

The $8M auction payment is an economic transfer within the system. Security depends on who owns and controls the mining rights.

## 4. Model B — PoW-earned mining rights

Miners compete in a 24-hour PoW window. Each miner's share of accepted work determines their share of block-production opportunities over the next 30 days. The rights expire at the end of that period and must be earned again.

A shorter competition window can still lead to high total expenditure. If the rights are worth $10M, miners can spend nearly $10M competing to acquire them.

### Hybrid variant with 51% mining rights and 49% ordinary PoW

Run both production modes on one chain. Each cycle has 49 ordinary PoW blocks and 51 scheduled rights slots. Each PoW block is preceded by one rights slot, with a second slot before two evenly spaced PoW blocks per cycle. With equal block subsidies, the schedule gives rights holders 51% of potential issuance. A missed rights slot pays no subsidy, so the realized split can differ.

#### Ticket allocation

During a roughly 24-hour allocation window, miners submit tickets that meet a protocol-set hash target and commit to the upcoming rights epoch, a recent PoW block, and the miner's public key. Nodes count each valid ticket included in the chain once. For a prototype, keep the ticket target fixed within each window so each ticket carries equal weight. Close the window far enough ahead of activation for the tally to gain PoW confirmations, then use a public seed to draw a winning ticket for each rights slot in the roughly 30-day epoch.

A miner with 10% of accepted tickets can expect 10% of the rights slots, or 5.1% of all scheduled block opportunities, plus any ordinary PoW blocks they mine. The prototype can measure both windows in ordinary PoW block heights calibrated to the intended durations. Rights expire at the end of the epoch.

#### Block production and confirmation

The selected ticket holder signs a transaction block for its slot. The following PoW block commits to the signed blocks it includes and identifies any skipped slots. The protocol needs a consensus-verifiable rule for when a slot may be skipped so an offline rights holder cannot halt the chain. Rights blocks are provisional until included by a PoW block, and that inclusion can be reversed by a PoW reorganization. If a rights holder signs competing versions, the PoW block's commitment determines which version it confirms.

#### Fork choice

Nodes follow the valid history with the most cumulative ordinary block work. Tickets determine eligibility for rights slots and contribute zero weight to fork choice. Rights holders get most scheduled production, while ordinary PoW miners settle competing histories.

#### Open design questions

- How much influence do PoW miners have over which tickets and rights blocks make it into the chain?
- What consensus rule lets nodes verify that a slot can be skipped?
- How much can a miner bias the lottery if the seed comes from a single PoW block?

## 5. Model C — Mining rights with delayed rewards

This model combines temporary mining rights with a vesting period for block rewards.

- Miners receive rights to produce blocks.
- Rights have a limited lifespan.
- Block rewards vest over 12 months.
- Mining rights can be transferable, but unvested rewards remain subject to protocol rules.

This creates a long-term economic stake for miners.

It could also support penalties for objectively provable violations, such as signing conflicting blocks at the same height.

Delayed rewards reduce the present value of block rewards, which can lower equilibrium mining expenditure. Vesting also changes miners' financing requirements.

## 6. Comparison of allocation mechanisms

| Mechanism                 | Resource expenditure | Permissionless entry      | Primary weakness       |
| ------------------------- | -------------------- | ------------------------- | ---------------------- |
| Conventional PoW          | High                 | Yes                       | Rent dissipation       |
| Auctioned mining rights   | Low physical cost    | Capital-dependent         | Wealth concentration   |
| PoW-earned rights         | Potentially high     | Yes                       | Competition for rights |
| Randomly allocated rights | Low                  | Requires Sybil resistance | Identity manipulation  |
| Staked mining rights      | Low physical cost    | Capital-dependent         | Stake concentration    |
| Reputation-based rights   | Low                  | Limited                   | Entrenchment           |

Allocating scarce mining rights among pseudonymous participants requires Sybil resistance to prevent participants from gaining an advantage by creating additional identities.

PoW uses energy. PoS uses capital. Identity-based systems use verification or trust.

## 7. Separate issuance from security

Bitcoin's block subsidy distributes new coins and pays miners to secure the chain. Aurea could assign those functions separate budgets.

For example, distribute 80% of new coins through a predetermined mechanism, while reserving 20% for block-production security.

Then allocate mining rights through an auction or stake-based selection, and use delayed vesting to make block producers economically accountable.

This reduces the amount of new issuance exposed to the competitive mining race. But the remaining 20% still needs to provide sufficient security, and the 80% distribution needs a Sybil-resistant allocation rule.

## 8. Research objective

Evaluate whether Aurea can reduce the real resources spent on consensus for a given level of security while preserving permissionless participation and decentralization.
