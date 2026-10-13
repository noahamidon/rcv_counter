// normalize.js — Flags likely name-variant merges for admin confirmation.
// Never silently merges. All decisions are explicit and logged.

// Canonicalization used ONLY for comparison (case, accents, punctuation).
function canon(s) {
  return s
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Optimal-string-alignment distance: insertions, deletions, substitutions
// and adjacent swaps ("Lui" ↔ "Liu") each cost 1.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Allowed typo budget scales with name length.
function typoBudget(len) {
  return len <= 5 ? 0 : len <= 10 ? 1 : 2;
}

// Ways a write-in can refer to an established candidate, strongest first.
// Each returns a reason string when `v` (variant) matches `c` (candidate).
const RULES = [
  (v, c) => v.key === c.key && "case/spacing/accent differences",
  (v, c) => {
    const dist = editDistance(v.key, c.key);
    return dist > 0 && dist <= typoBudget(c.key.length) &&
      `likely typo (${dist} letter${dist === 1 ? "" : "s"} off)`;
  },
  // "Max Corbett" → "Maxwell Corbett": same last name, first name shortened.
  (v, c) => v.tokens.length >= 2 && v.tokens.length === c.tokens.length &&
    v.tokens.at(-1) === c.tokens.at(-1) &&
    v.tokens[0].length >= 3 && c.tokens[0].startsWith(v.tokens[0]) &&
    v.tokens[0] !== c.tokens[0] && "shortened first name",
  // "Seiko Tejirian" → "Seiko Helen Tejirian": every written word is in the name.
  (v, c) => v.tokens.length >= 2 && v.tokens.length < c.tokens.length &&
    v.tokens.every(t => c.tokens.includes(t)) && "partial name",
  // "Vanna" → "Vanna Lei": a lone first or last name.
  (v, c) => v.tokens.length === 1 && v.key.length >= 3 && c.tokens.length >= 2 &&
    (c.tokens[0] === v.key || c.tokens.at(-1) === v.key) && "first or last name only"
];

function describe(name) {
  const key = canon(name);
  return { name, key, tokens: key.split(" ").filter(Boolean) };
}

// Returns [{ variant, canonical, reason }], one per name that looks like
// another spelling of an established candidate.
//
// candidates:     every name appearing on any ballot (pre-merge)
// weights:        Map name -> number of ballots naming it; picks which
//                 spelling of a group becomes the canonical one
// protectedNames: names from the official ballot (rank columns). These are
//                 real, distinct candidates, so they are never fuzzy-matched
//                 to each other — only exact case/spacing duplicates merge.
export function suggestMerges(candidates, { weights = new Map(), protectedNames = [] } = {}) {
  const isProtected = new Set(protectedNames);
  const weight = n => weights.get(n) ?? 0;
  const polish = n => (n.match(/\p{Lu}/gu) || []).length;

  // Official names first, then the most common spellings — so the canonical
  // form of any group is the most authoritative one available.
  const ordered = [...new Set(candidates)].sort((a, b) =>
    (isProtected.has(b) - isProtected.has(a)) ||
    (weight(b) - weight(a)) ||
    (polish(b) - polish(a)) ||
    a.localeCompare(b)
  );

  const established = [];
  const suggestions = [];
  for (const name of ordered) {
    const v = describe(name);
    let match = null;
    for (const [ruleIdx, rule] of RULES.entries()) {
      // Two official candidates are only ever merged for exact duplicates.
      if (ruleIdx > 0 && isProtected.has(name)) break;
      const hits = established
        .map(c => ({ c, reason: rule(v, c) }))
        .filter(h => h.reason);
      if (hits.length === 1) { match = hits[0]; break; }
      if (hits.length > 1) break;  // ambiguous ("Lydia" could be two people) — leave it
    }
    if (match) {
      suggestions.push({ variant: name, canonical: match.c.name, reason: match.reason });
    } else {
      established.push(v);
    }
  }
  return suggestions;
}

// Apply an admin-approved merge map to every ballot.
// mergeMap: { "variant" -> "canonical" }
export function applyMerges(ballots, mergeMap) {
  if (!mergeMap || Object.keys(mergeMap).length === 0) return ballots;
  return ballots.map(b => ({
    ...b,
    ranking: b.ranking.map(n => mergeMap[n] ?? n)
  }));
}

// After merging, ballots can contain the same canonical name twice (e.g. if a
// voter listed both "Willow Dubrovin" at rank 3 and "Willow DuBrovin" at rank 7).
// Deduplicate by keeping the earliest rank — same rule as parse.js and the R script.
export function dedupeRankings(ballots) {
  return ballots.map(b => {
    const seen = new Set();
    const ranking = [];
    for (const n of b.ranking) {
      if (seen.has(n)) continue;
      seen.add(n);
      ranking.push(n);
    }
    return { ...b, ranking };
  });
}
