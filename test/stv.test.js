// Unit tests for the STV algorithm.
// Run with: node --test test/stv.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSTV } from "../js/stv.js";

function mkBallots(list) {
  // helper: [["A", "B"], ["B"], ...] -> [{ranking: ["A","B"], weight: 1, originalIndex: 1}, ...]
  return list.map((r, i) => ({ ranking: r, weight: 1, originalIndex: i + 1 }));
}

test("tiny election: 2 candidates, 1 seat, clear winner", () => {
  const ballots = mkBallots([
    ["Alice"], ["Alice"], ["Alice"],
    ["Bob"], ["Bob"]
  ]);
  const r = runSTV({ ballots, candidates: ["Alice", "Bob"], seats: 1 });
  assert.deepEqual(r.winners, ["Alice"]);
  assert.equal(r.quota, Math.floor(5 / 2) + 1); // 3
});

test("Droop quota calculation with 491 ballots and 2 seats", () => {
  // quota = floor(491 / 3) + 1 = 163 + 1 = 164 — matches our real-world test.
  const ballots = Array.from({ length: 491 }, (_, i) => ({
    ranking: i % 2 === 0 ? ["A", "B"] : ["B", "A"],
    weight: 1,
    originalIndex: i + 1
  }));
  const r = runSTV({ ballots, candidates: ["A", "B"], seats: 2 });
  assert.equal(r.quota, 164);
  assert.equal(r.winners.length, 2);
});

test("all candidates elected when hopefuls <= seats", () => {
  // 3 candidates, 3 seats — no one needs to reach quota; all should be elected.
  const ballots = mkBallots([
    ["A"], ["A"], ["B"], ["B"], ["C"]
  ]);
  const r = runSTV({ ballots, candidates: ["A", "B", "C"], seats: 3 });
  assert.deepEqual(new Set(r.winners), new Set(["A", "B", "C"]));
});

test("surplus transfer: elected candidate's surplus flows to next preference", () => {
  // 10 ballots, 2 seats. Quota = floor(10/3) + 1 = 4.
  // Alice gets 6 first-prefs (2 surplus); all her voters' 2nd choice is Bob.
  // Carol gets 3 first-prefs, Dan gets 1.
  // After electing Alice, her surplus (2) transfers to Bob.
  // Bob then has 2 votes (from transfer). Carol = 3, Dan = 1.
  // No one else reaches quota. Dan (lowest) eliminated.
  // Dan's 1 vote — say next pref is Carol. Carol = 4, reaches quota.
  const ballots = mkBallots([
    ["Alice", "Bob"], ["Alice", "Bob"], ["Alice", "Bob"],
    ["Alice", "Bob"], ["Alice", "Bob"], ["Alice", "Bob"],
    ["Carol"], ["Carol"], ["Carol"],
    ["Dan", "Carol"]
  ]);
  const r = runSTV({ ballots, candidates: ["Alice", "Bob", "Carol", "Dan"], seats: 2 });
  assert.equal(r.quota, 4);
  assert.ok(r.winners.includes("Alice"), "Alice must win (6 first-prefs)");
  assert.equal(r.winners.length, 2);
  // The second seat should be Carol (reaches quota after Dan transfer) or Bob.
  // With these ballots, Carol has clear majority of remaining votes.
  assert.ok(r.winners.includes("Carol"), `Expected Carol among winners, got ${r.winners}`);
});

test("exclusion: excluded candidate's votes transfer to next preference", () => {
  const ballots = mkBallots([
    ["Alice", "Bob"], ["Alice", "Bob"], ["Alice", "Bob"],
    ["Bob"], ["Bob"],
    ["Carol"]
  ]);
  // Without exclusion: Alice wins with 3.
  // With Alice excluded: Bob wins with 3+2=5, Carol has 1.
  const r1 = runSTV({ ballots, candidates: ["Alice", "Bob", "Carol"], seats: 1 });
  assert.deepEqual(r1.winners, ["Alice"]);

  const r2 = runSTV({
    ballots, candidates: ["Alice", "Bob", "Carol"], seats: 1,
    excluded: ["Alice"]
  });
  assert.deepEqual(r2.winners, ["Bob"]);
});

test("add-a-seat rerun: previous winners remain, a new winner is added", () => {
  const ballots = mkBallots([
    ["A", "B", "C"], ["A", "B", "C"], ["A", "B", "C"], ["A", "B", "C"], ["A", "B", "C"],
    ["B", "A", "C"], ["B", "A", "C"], ["B", "A", "C"],
    ["C", "B", "A"], ["C", "B", "A"]
  ]);
  const r2 = runSTV({ ballots, candidates: ["A", "B", "C"], seats: 2 });
  const r3 = runSTV({ ballots, candidates: ["A", "B", "C"], seats: 3 });
  // Everyone elected with seats=3
  assert.equal(r3.winners.length, 3);
  // Winners from seats=2 must be a subset of seats=3 winners
  for (const w of r2.winners) {
    assert.ok(r3.winners.includes(w), `${w} missing from seats=3 winners`);
  }
});

test("exhausted ballots counted when no remaining preferences", () => {
  // Voter lists only one candidate. When that candidate is eliminated, ballot exhausts.
  const ballots = mkBallots([
    ["A"], ["A"],                    // 2 bullets for A
    ["B"], ["B"], ["B"],             // 3 for B
    ["C"], ["C"], ["C"], ["C"]       // 4 for C
  ]);
  // 9 ballots, 1 seat -> quota = floor(9/2)+1 = 5.
  // Nobody reaches 5. A (lowest, 2) eliminated. Both ballots exhaust.
  // B = 3, C = 4. B eliminated. Exhausts. C wins by default.
  const r = runSTV({ ballots, candidates: ["A", "B", "C"], seats: 1 });
  assert.deepEqual(r.winners, ["C"]);
  assert.ok(r.exhaustedBallots > 0, "should have exhausted ballots");
});

test("ties broken deterministically by previous round, then alphabetically", () => {
  // Perfect tie — A and B each get 1 vote. Must pick one deterministically.
  const ballots = mkBallots([["A"], ["B"]]);
  const r = runSTV({ ballots, candidates: ["A", "B"], seats: 1 });
  // Both have 1 vote. Neither meets quota=2. Lowest (tied) eliminated — alphabetical -> A.
  // Then B wins as the only remaining hopeful.
  assert.deepEqual(r.winners, ["B"]);
});

test("auditable round log exists and has expected shape", () => {
  const ballots = mkBallots([["A", "B"], ["A"], ["B"], ["C"]]);
  const r = runSTV({ ballots, candidates: ["A", "B", "C"], seats: 1 });
  assert.ok(Array.isArray(r.rounds), "rounds must be an array");
  assert.ok(r.rounds.length >= 1, "at least one round");
  for (const rd of r.rounds) {
    assert.ok(Array.isArray(rd.tally), "each round has a tally");
    assert.ok(Array.isArray(rd.events), "each round has an events list");
    assert.equal(typeof rd.quota, "number");
  }
});

test("refuses to run if seats > available candidates", () => {
  const ballots = mkBallots([["A"], ["B"]]);
  assert.throws(
    () => runSTV({ ballots, candidates: ["A", "B"], seats: 3 }),
    /seats/i
  );
});
