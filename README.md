# Token Radar — pre-token protocols ranked by implied value

A token launch radar for make.fun's `token-radar-01` bounty. It reads a sealed DefiLlama
snapshot, finds the protocols that record no token yet, ranks them by an implied launch value
derived from the snapshot itself, and hands in a dashboard a reader can use: a sortable,
filterable board, a detail view for every protocol, and the concrete steps to farm each one.

## The model

Implied value is computed at runtime from the snapshot's own figures — never from a
hardcoded list of names:

```
multiple  = the category's median market-cap/TVL among the snapshot's own tokenized
            protocols, shrunk toward the global median with a prior weight of 5,
            clamped to 0.05–3.0. A category with no tokenized comps uses the global median.
growth    = 1 + clamp(change_7d / 100, -0.5, 1.0); a missing 7d change counts as 0.
age       = 1 + min(age_years, 3) * 0.08; age from listed_at to the snapshot's as_of date.
chains    = 1 + min(chains.length - 1, 8) * 0.015.
implied   = round(tvl_usd * multiple * growth * age * chains)
```

A protocol is a legitimate candidate when DefiLlama records no token for it (no CoinGecko id,
no symbol) and it is not a wrapped, staked or bridged product of a token that already trades,
not a versioned pool, and not an exchange. The board ranks all 198 such protocols — the
watchlist's 40 plus 158 more below the floor. Protocols whose token already trades are shown
apart in the Live view, never ranked.

Every row carries the four factors, so the number is auditable from the snapshot alone, and
the dashboard recomputes it in the page from the same figures.

## Run it

```
mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_INPUT_DIR=../input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads the snapshot, writes `out/board.json` (198 rows), `out/data.js` (the
dashboard's data), copies `dashboard/` and `screenshots/` into `out/`, and writes
`out/dossier.json` once `screenshots/` holds the three screenshots. The program is
deterministic: two runs write identical bytes.

## Referral

Made for make.fun — referral code `afssbf1x`.
