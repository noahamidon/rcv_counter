// Unit tests for parse.js — race detection and write-in parsing.
// Run with: node --test test/parse.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWriteInText } from "../js/parse.js";

// ─── parseWriteInText (regex-based, no PapaParse needed) ───

test("parseWriteInText: single name → rank 1", () => {
  assert.deepEqual(parseWriteInText("William Kiker"), [{ name: "William Kiker", rank: 1 }]);
  assert.deepEqual(parseWriteInText("Kanye"), [{ name: "Kanye", rank: 1 }]);
});

test("parseWriteInText: '1. Name  2. Name' numbered format", () => {
  const out = parseWriteInText("1. Abbie Deng   2. Daniel Sparks");
  assert.equal(out.length, 2);
  assert.equal(out[0].rank, 1);
  assert.equal(out[0].name, "Abbie Deng");
  assert.equal(out[1].rank, 2);
  assert.equal(out[1].name, "Daniel Sparks");
});

test("parseWriteInText: '1) Name' bracket format", () => {
  const out = parseWriteInText("1)Trace Ribble");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Trace Ribble");
});

test("parseWriteInText: 'Rank 1: Name Rank 2: Name'", () => {
  const out = parseWriteInText("Rank 1: Mia Bomback  Rank 2: Emma Bell");
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Mia Bomback");
  assert.equal(out[1].name, "Emma Bell");
});

test("parseWriteInText: 'Name, rank;' format", () => {
  const out = parseWriteInText('Mitchell "King" Monte, 1');
  assert.ok(out, "should parse name,rank form");
  // The name-extraction may or may not keep quotes; just check rank parsed
  assert.equal(out[0].rank, 1);
});

test("parseWriteInText: unparseable gobbledygook returns null", () => {
  assert.equal(parseWriteInText("!!! ???"), null);
  assert.equal(parseWriteInText("42"), null);
});

test("parseWriteInText: empty / whitespace returns empty list", () => {
  assert.deepEqual(parseWriteInText(""), []);
  assert.deepEqual(parseWriteInText("   \t  "), []);
});

test("parseWriteInText: 'Name, rank, Name, rank' comma lists", () => {
  const out = parseWriteInText("Vanna Lei, 1, Justus Gabbard, 2, Reid Barry, 3, Stas Kolodkin");
  assert.deepEqual(out.map(p => p.name), ["Vanna Lei", "Justus Gabbard", "Reid Barry", "Stas Kolodkin"]);
  assert.deepEqual(out.map(p => p.rank), [1, 2, 3, 4]);
});

test("parseWriteInText: trailing rank number and filler words are stripped", () => {
  assert.deepEqual(parseWriteInText("Henry Gillibrand 1"), [{ name: "Henry Gillibrand", rank: 1 }]);
  assert.deepEqual(parseWriteInText("Lydia Lin Name"), [{ name: "Lydia Lin", rank: 1 }]);
  assert.equal(parseWriteInText("Name1"), null);
});

test("parseWriteInText: mixed separators and ordinals", () => {
  const out = parseWriteInText("Maxwell Corbett,1 : Stas Kolodkin,2: Jackson Loftus");
  assert.deepEqual(out.map(p => p.name), ["Maxwell Corbett", "Stas Kolodkin", "Jackson Loftus"]);
  const ord = parseWriteInText("1st Florence Liu 2nd Max Corbett");
  assert.deepEqual(ord.map(p => p.name), ["Florence Liu", "Max Corbett"]);
});

// ─── Race detection (needs a PapaParse shim in Node) ───
// We import the full module only if PapaParse is available. Below we shim a
// minimal Papa.parse and then dynamically import parse.js.

test("parseSurveyCsv: detects a single race (Fall-style)", async () => {
  // Minimal PapaParse shim: handles the unquoted simple CSVs we emit below.
  globalThis.Papa = {
    parse(text) {
      const lines = text.split(/\r?\n/).filter(l => l.length > 0);
      const data = lines.map(l => l.split(","));
      return { data, errors: [] };
    }
  };
  const { parseSurveyCsv } = await import("../js/parse.js?t=1");

  const csv = [
    "User Id,notes,The balloted candidates for the Class of 2029 ... include Alice and Bob.,Please rank the candidates below - 1,Please rank the candidates below - 2,Please rank the candidates below - 3,Please write in as many candidates as you wish for the Class of 2029 race",
    "u1,,No,Alice,Bob,,",
    "u2,,No,Bob,Alice,,",
    "u3,,No,Alice,,,",
    "u4,,Yes,,,,Eve"
  ].join("\n");

  const parsed = parseSurveyCsv(csv);
  assert.equal(parsed.races.length, 1, "should detect exactly one race");
  const race = parsed.races[0];
  assert.equal(race.classYear, 2029);
  assert.equal(race.rankCols.length, 3);
  assert.equal(race.ballots.length, 3, "3 non-empty ranked ballots");
  assert.equal(race.writeIns.length, 1);
  assert.equal(race.writeIns[0].rawText, "Eve");
  assert.equal(race.headerClassMismatch, null);
});

test("parseSurveyCsv: detects multiple races (Spring-style)", async () => {
  globalThis.Papa = {
    parse(text) {
      const lines = text.split(/\r?\n/).filter(l => l.length > 0);
      const data = lines.map(l => l.split(","));
      return { data, errors: [] };
    }
  };
  const { parseSurveyCsv } = await import("../js/parse.js?t=2");

  // Two races back-to-back in one header.
  const csv = [
    [
      "User Id",
      "The balloted candidates for the Class of 2028 include A and B.",
      "Please rank the candidates below - 1",
      "Please rank the candidates below - 2",
      "Please write in as many candidates as you wish for the Class of 2028 race",
      "The balloted candidates for the Class of 2027 include C and D.",
      "Please rank the candidates below - 1",
      "Please rank the candidates below - 2",
      "Please write in as many candidates as you wish for the Class of 2027 race"
    ].join(","),
    "u1,No,A,B,,No,C,D,",
    "u2,No,B,A,,No,D,C,",
    "u3,No,A,,,No,,,"
  ].join("\n");

  const parsed = parseSurveyCsv(csv);
  assert.equal(parsed.races.length, 2);
  // Sorted newest first → 2028 first, 2027 second
  assert.equal(parsed.races[0].classYear, 2028);
  assert.equal(parsed.races[1].classYear, 2027);
});

test("parseSurveyCsv: flags header-class mismatch (the Spring 2027 bug)", async () => {
  globalThis.Papa = {
    parse(text) {
      const lines = text.split(/\r?\n/).filter(l => l.length > 0);
      const data = lines.map(l => l.split(","));
      return { data, errors: [] };
    }
  };
  const { parseSurveyCsv } = await import("../js/parse.js?t=3");

  // Rank header says "Class of 2026" but anchor (balloted candidates) says 2027.
  const csv = [
    [
      "User Id",
      "The balloted candidates for the Class of 2027 include A and B.",  // anchor-before: 2027
      "Please rank the candidates below for the Class of 2026 - 1",       // rank-header: 2026 (bug!)
      "Please rank the candidates below for the Class of 2026 - 2",       // rank-header: 2026 (bug!)
      "Please write in as many candidates as you wish for the Class of 2027 race"  // anchor-after: 2027
    ].join(","),
    "u1,No,A,B,"
  ].join("\n");

  const parsed = parseSurveyCsv(csv);
  assert.equal(parsed.races.length, 1);
  const race = parsed.races[0];
  assert.equal(race.classYear, 2027, "should trust the anchor (2027) not the rank header (2026)");
  assert.ok(race.headerClassMismatch, "should surface a mismatch warning");
  assert.match(race.headerClassMismatch, /2026/);
  assert.match(race.headerClassMismatch, /2027/);
});

test("parseSurveyCsv: rejects files with no rank columns", async () => {
  globalThis.Papa = {
    parse(text) {
      const lines = text.split(/\r?\n/).filter(l => l.length > 0);
      const data = lines.map(l => l.split(","));
      return { data, errors: [] };
    }
  };
  const { parseSurveyCsv } = await import("../js/parse.js?t=4");
  const csv = "Name,Age\nAlice,20\nBob,21";
  assert.throws(() => parseSurveyCsv(csv), /ranked-choice races|rank columns/i);
});
