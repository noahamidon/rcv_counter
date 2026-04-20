// normalize.js — Flags likely name-variant merges for admin confirmation.
// Never silently merges. All decisions are explicit and logged.

// Canonicalization used ONLY for comparison (whitespace + case).
function canon(s) {
  return s
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "") // strip accents for comparison
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function suggestMerges(candidates) {
  // Returns array of groups where each group is a set of names that
  // collapse to the same canonical form. Groups of size >= 2 are candidates
  // for merging and should be shown to the admin.
  const groups = new Map();
  for (const c of candidates) {
    const k = canon(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const suggestions = [];
  for (const [, names] of groups) {
    if (names.length > 1) {
      // Pick the "most polished" form as the suggested canonical name:
      // prefer the one with capital letters (Title Case usually wins).
      const ranked = [...names].sort((a, b) => {
        const capA = (a.match(/[A-Z]/g) || []).length;
        const capB = (b.match(/[A-Z]/g) || []).length;
        if (capA !== capB) return capB - capA;
        return a.length - b.length;
      });
      suggestions.push({
        canonical: ranked[0],
        variants: names,
        reason: "case/whitespace/accent differences"
      });
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
