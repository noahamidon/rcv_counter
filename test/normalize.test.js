// Unit tests for name-merge suggestions.
// Run with: node --test test/normalize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestMerges } from "../js/normalize.js";

const OFFICIAL = ["Florence Liu", "Maxwell Corbett", "Vanna Lei", "Henry Gillibrand",
  "Cayden Dunn", "Seiko Helen Tejirian", "Stas Kolodkin"];

function mergeMap(names, protectedNames = OFFICIAL) {
  return Object.fromEntries(
    suggestMerges([...protectedNames, ...names], { protectedNames }).map(s => [s.variant, s.canonical])
  );
}

test("typos map to the official candidate", () => {
  assert.deepEqual(mergeMap(["Florence Lui", "Florence Lou", "Maxwell Corbet", "Cayden Dubb", "Stad Kolodkin"]), {
    "Florence Lui": "Florence Liu",
    "Florence Lou": "Florence Liu",
    "Maxwell Corbet": "Maxwell Corbett",
    "Cayden Dubb": "Cayden Dunn",
    "Stad Kolodkin": "Stas Kolodkin"
  });
});

test("shortened, partial and single-word names map to the official candidate", () => {
  assert.deepEqual(mergeMap(["Max Corbett", "Seiko Tejirian", "Vanna", "Henry"]), {
    "Max Corbett": "Maxwell Corbett",
    "Seiko Tejirian": "Seiko Helen Tejirian",
    "Vanna": "Vanna Lei",
    "Henry": "Henry Gillibrand"
  });
});

test("case/spacing duplicates still merge", () => {
  assert.deepEqual(mergeMap(["florence  LIU"]), { "florence  LIU": "Florence Liu" });
});

test("official candidates with similar names are never merged together", () => {
  assert.deepEqual(mergeMap([], ["Lydia Lin", "Lydia Liu"]), {});
});

test("ambiguous write-ins are left alone", () => {
  assert.deepEqual(mergeMap(["Lydia", "Lydia Lim"], ["Lydia Lin", "Lydia Liu"]), {});
});

test("unrelated write-ins are not suggested", () => {
  assert.deepEqual(mergeMap(["Cookie Monster", "William Harrington"]), {});
});

test("most common spelling becomes canonical among write-ins", () => {
  const weights = new Map([["Jamie Rivera", 5], ["Jamie Riviera", 1]]);
  const out = suggestMerges(["Jamie Riviera", "Jamie Rivera"], { weights });
  assert.deepEqual(out.map(s => [s.variant, s.canonical]), [["Jamie Riviera", "Jamie Rivera"]]);
});
