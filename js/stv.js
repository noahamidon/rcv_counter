// stv.js — Single Transferable Vote count.
//
// Algorithm: Weighted Inclusive Gregory Method (WIGM) with Droop quota.
// This is the variant used by Scottish local-government elections (and is
// structurally similar to what R's `vote::count.votes(method="stv")` does
// under its default settings). Results should match in all but the tightest
// surplus-transfer cases.
//
// Input ballot shape:
//   { ranking: ["Alice", "Bob", ...], weight: 1.0 }
// where `ranking` is an ordered list of candidate names (no duplicates, no blanks).

const EPSILON = 1e-9;

export function runSTV({ ballots, candidates, seats, excluded = [], tieBreaker = "alphabetical" }) {
  // Defensive copies
  candidates = [...new Set(candidates)];
  excluded = new Set(excluded);

  // Strip excluded candidates from every ballot up-front.
  const workingBallots = ballots
    .map(b => ({
      ranking: b.ranking.filter(c => !excluded.has(c)),
      weight: 1.0,
      originalIndex: b.originalIndex
    }))
    .filter(b => b.ranking.length > 0);

  const activeCandidates = candidates.filter(c => !excluded.has(c));

  if (!Number.isInteger(seats) || seats < 1) {
    throw new Error(`Seats must be a positive whole number (got ${seats}).`);
  }
  if (seats > activeCandidates.length) {
    throw new Error(`Asked for ${seats} seats but only ${activeCandidates.length} candidates available after exclusions.`);
  }

  const totalValid = workingBallots.length;
  // Droop quota — the classic formula. With fractional weights it can also
  // be written as V/(S+1) + ε, but using floor+1 keeps it integer-comparable
  // for the "strictly exceeds" check and matches every textbook statement.
  const quota = Math.floor(totalValid / (seats + 1)) + 1;

  const elected = [];        // in order of election
  const eliminated = [];     // in order of elimination
  const rounds = [];
  const state = {
    // candidate -> { status: "hopeful" | "elected" | "eliminated", electedRound, eliminatedRound }
    candidates: new Map(activeCandidates.map(c => [c, { status: "hopeful" }]))
  };

  // Pre-compute "next preference" index on each ballot. We mutate this as
  // candidates get elected/eliminated.
  const ballotPtrs = workingBallots.map(() => 0);

  function advance(ballot, ptrIndex) {
    // Move ptr past any elected/eliminated candidates. Returns new ptr, or -1 if exhausted.
    let p = ballotPtrs[ptrIndex];
    while (p < ballot.ranking.length) {
      const c = ballot.ranking[p];
      const st = state.candidates.get(c);
      if (st && st.status === "hopeful") {
        ballotPtrs[ptrIndex] = p;
        return p;
      }
      p++;
    }
    ballotPtrs[ptrIndex] = p;
    return -1;
  }

  function currentTally() {
    // Assign each ballot's weight to its current top hopeful.
    const tally = new Map();
    const contributors = new Map(); // candidate -> array of ballot indices
    let exhausted = 0;
    let exhaustedWeight = 0;

    for (const [c, st] of state.candidates) {
      if (st.status === "hopeful") {
        tally.set(c, 0);
        contributors.set(c, []);
      }
    }

    for (let i = 0; i < workingBallots.length; i++) {
      const b = workingBallots[i];
      const p = advance(b, i);
      if (p === -1) {
        // Ballots whose weight was fully used up electing someone (surplus 0)
        // aren't "exhausted" in any meaningful sense — don't count them.
        if (b.weight > EPSILON) exhausted++;
        exhaustedWeight += b.weight;
      } else {
        const c = b.ranking[p];
        tally.set(c, tally.get(c) + b.weight);
        contributors.get(c).push(i);
      }
    }
    return { tally, contributors, exhausted, exhaustedWeight };
  }

  function breakTie(tied, mode, pastTallies) {
    // mode: "lowest" when eliminating, "highest" when picking largest surplus
    if (tied.length === 1) return tied[0];

    // Try previous-round values (earliest round first).
    for (const past of pastTallies) {
      const values = tied.map(c => past.get(c) ?? 0);
      const best = (mode === "lowest") ? Math.min(...values) : Math.max(...values);
      const winners = tied.filter(c => Math.abs((past.get(c) ?? 0) - best) < EPSILON);
      if (winners.length < tied.length) {
        return breakTie(winners, mode, pastTallies); // recursive narrowing
      }
    }

    // Still tied. Alphabetical by default (deterministic).
    const sorted = [...tied].sort();
    return mode === "lowest" ? sorted[0] : sorted[sorted.length - 1];
  }

  const pastTallies = []; // for tie-breaking history

  let round = 0;
  while (elected.length < seats) {
    round++;
    const { tally, contributors, exhausted, exhaustedWeight } = currentTally();
    pastTallies.unshift(new Map(tally)); // newest first

    const roundEntry = {
      round,
      tally: [...tally.entries()].sort((a, b) => b[1] - a[1]),
      quota,
      exhausted,
      exhaustedWeight,
      events: []
    };

    // --- Check: any hopeful meets or exceeds quota? ---
    const reached = [...tally.entries()]
      .filter(([, v]) => v >= quota - EPSILON)
      .sort((a, b) => b[1] - a[1]); // highest first

    if (reached.length > 0) {
      // Elect them in descending tally order, resolving ties.
      const groups = [];
      for (const [c, v] of reached) {
        const last = groups[groups.length - 1];
        if (last && Math.abs(last[0][1] - v) < EPSILON) last.push([c, v]);
        else groups.push([[c, v]]);
      }
      const electionOrder = [];
      for (const grp of groups) {
        if (grp.length === 1) {
          electionOrder.push(grp[0]);
        } else {
          // Tied-at-quota election — elect all, but order them for record.
          const ordered = [];
          let remaining = grp.map(g => g[0]);
          while (remaining.length) {
            const pick = breakTie(remaining, "highest", pastTallies.slice(1));
            ordered.push([pick, grp.find(g => g[0] === pick)[1]]);
            remaining = remaining.filter(c => c !== pick);
          }
          electionOrder.push(...ordered);
        }
      }

      for (const [c, v] of electionOrder) {
        if (elected.length >= seats) break;
        state.candidates.get(c).status = "elected";
        state.candidates.get(c).electedRound = round;
        elected.push({ name: c, round, tally: v });
        roundEntry.events.push({ type: "elect", candidate: c, tally: v });

        // Surplus transfer. WIGM: every ballot currently counting for this
        // candidate has its weight multiplied by (surplus / total), then the
        // ballot moves to its next hopeful preference on the next tally pass.
        // This must run even when surplus is 0: the ballots still advance past
        // the elected candidate, and they must do so carrying zero weight.
        const surplus = Math.max(0, v - quota);
        const fraction = surplus / v;
        for (const bi of contributors.get(c)) {
          workingBallots[bi].weight *= fraction;
        }
        if (surplus > EPSILON) {
          roundEntry.events.push({
            type: "transfer",
            from: c,
            surplus,
            fraction
          });
        }
      }
      rounds.push(roundEntry);
      if (elected.length >= seats) break;
      continue;
    }

    // --- No one reached quota. Check early-termination: hopefuls == seats-left ---
    const hopefuls = [...state.candidates.entries()]
      .filter(([, st]) => st.status === "hopeful")
      .map(([c]) => c);
    const seatsLeft = seats - elected.length;

    if (hopefuls.length <= seatsLeft) {
      // Elect everyone remaining, in descending tally order.
      const ordered = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      for (const [c, v] of ordered) {
        state.candidates.get(c).status = "elected";
        state.candidates.get(c).electedRound = round;
        elected.push({ name: c, round, tally: v });
        roundEntry.events.push({ type: "elect-default", candidate: c, tally: v });
      }
      rounds.push(roundEntry);
      break;
    }

    // --- Eliminate the lowest. ---
    const lowestValue = Math.min(...tally.values());
    const lowestCandidates = [...tally.entries()]
      .filter(([, v]) => Math.abs(v - lowestValue) < EPSILON)
      .map(([c]) => c);
    const toEliminate = breakTie(lowestCandidates, "lowest", pastTallies.slice(1));

    state.candidates.get(toEliminate).status = "eliminated";
    state.candidates.get(toEliminate).eliminatedRound = round;
    eliminated.push({ name: toEliminate, round, tally: tally.get(toEliminate) });
    roundEntry.events.push({
      type: "eliminate",
      candidate: toEliminate,
      tally: tally.get(toEliminate),
      tiedWith: lowestCandidates.length > 1 ? lowestCandidates.filter(c => c !== toEliminate) : []
    });

    rounds.push(roundEntry);
  }

  // Exhausted totals as of the last round counted. (Re-tallying after the
  // final election would wrongly count ballots sitting with the last winners.)
  const lastRound = rounds[rounds.length - 1];

  return {
    seats,
    quota,
    totalBallots: totalValid,
    winners: elected.map(e => e.name),
    electedDetail: elected,
    eliminatedDetail: eliminated,
    rounds,
    exhaustedBallots: lastRound?.exhausted ?? 0,
    exhaustedWeight: lastRound?.exhaustedWeight ?? 0,
    excluded: [...excluded]
  };
}
