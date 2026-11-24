# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/weifu1997/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/weifu1997/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads the sealed DefiLlama snapshot, finds the protocols that record no token yet, prices each one as if it launched today, ranks them, and gives every row a concrete farm plan.

**The model — calibrated comps.** Every protocol in the snapshot whose token already trades is a comparable: its market cap over its TVL, medianed per category and shrunk toward the global median where a category has few tokens to go on. A pre-token protocol is priced at its TVL times its category's multiple, then adjusted for seven-day TVL momentum, for how long it has run without a token, and for how many chains it spans. Nothing is priced from a hardcoded list of names — add a protocol to the snapshot and the model prices it from its own figures alone.

**The board.** Candidates are protocols that record no token and are not a wrapped, staked or bridged product of a token that already trades, not an exchange, and not a versioned re-release — the same reading the snapshot's own watchlist uses, without its $50M floor. All 40 watchlist protocols are covered, and the board ranks every other candidate the snapshot holds besides. Each row carries a six-step farm plan with working capital, gas budgets and a plan length in weeks.

**The dashboard.** A static page (no network, no framework): a sortable, filterable board with search, category and chain filters and a watchlist toggle; a detail view per protocol showing the model's five factors and the full farm plan; and a method section that prints the calibrated multiples and the live tokens they were calibrated from.

## Run it

```sh
# Node.js 22.18 or later, standard library only. Point --input at the
# competition snapshot (the grader mounts it at /input/snapshot.json).
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
# Writes out/board.json, out/data.js, out/dashboard/, out/screenshots/
# and out/dossier.json. Open out/dashboard/index.html in a browser.
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
