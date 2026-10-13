// parse.js — Reads the raw Dartmouth survey export and extracts ranked ballots.
//
// A single file may contain 1 race (Fall — freshman General Senator) or N races
// (Spring — one General Senator race per continuing class). This module
// detects race boundaries automatically by:
//   (1) finding every rank column via header regex,
//   (2) grouping them into contiguous blocks (adjacent column indices AND
//       monotonically increasing rank numbers 1,2,3,…),
//   (3) resolving each block's true class from the "anchor" columns
//       immediately before/after the block (which hold the ground-truth
//       "balloted candidates for the Class of XXXX ..." text).
//
// The rank-column headers themselves can lie — the Spring 2025 export has
// cols 51–58 labeled "Class of 2026" but they're actually the Class of 2027
// race (confirmed by anchor columns 50 and 59). So we never trust the rank
// header alone; we cross-check against anchors and surface any mismatch.

const RANK_HEADER_RE = /rank.*\-\s*(\d+)\s*$/i;
const CLASS_RE = /\bClass of (\d{4})\b/i;
const ANCHOR_BEFORE_RE = /\bballoted candidates\b/i;
const ANCHOR_AFTER_RE  = /\bwrite in as many candidates\b/i;

const ANCHOR_LOOKBACK = 3;
const ANCHOR_LOOKAHEAD = 3;

export function parseSurveyCsv(csvText) {
  if (typeof Papa === "undefined") {
    throw new Error("PapaParse is not loaded. Check the <script> tag for papaparse in index.html.");
  }
  const parsed = Papa.parse(csvText, {
    header: false,
    skipEmptyLines: false,
    newline: "",
    transform: v => (typeof v === "string" ? v.trim() : v)
  });
  if (parsed.errors?.length) console.warn("CSV parse warnings:", parsed.errors.slice(0, 5));

  const rows = parsed.data.filter(r => r.some(cell => cell !== ""));
  if (rows.length < 2) throw new Error("CSV appears to be empty or has no data rows.");

  const header = rows[0].map(h => h.replace(/\s+/g, " ").trim());
  const dataRows = rows.slice(1);

  const races = detectRaces(header);
  if (races.length === 0) {
    throw new Error(
      'Couldn\'t find any ranked-choice races. Expected columns with headers like ' +
      '"Please rank the candidates ... - 1", "... - 2". Is this the right CSV export?'
    );
  }

  for (const race of races) buildRaceBallots(race, dataRows);

  // Sort races by class year (newest/youngest class first — matches how EPAC
  // typically reports Spring results: 2028 → 2027 → 2026).
  races.sort((a, b) => (b.classYear ?? 0) - (a.classYear ?? 0));

  return {
    header,
    totalRows: dataRows.length,
    races
  };
}

function detectRaces(header) {
  const rankCols = [];
  for (let i = 0; i < header.length; i++) {
    const m = header[i].match(RANK_HEADER_RE);
    if (m) {
      rankCols.push({ index: i, rankNumber: parseInt(m[1], 10), rawHeader: header[i] });
    }
  }
  if (rankCols.length === 0) return [];

  rankCols.sort((a, b) => a.index - b.index);
  // Group into contiguous blocks: same race = adjacent column indices AND
  // monotonic rank numbers (1,2,3,... restarting = new race).
  const groups = [];
  let current = [];
  for (const rc of rankCols) {
    const prev = current[current.length - 1];
    const adjacent = prev && rc.index === prev.index + 1 && rc.rankNumber === prev.rankNumber + 1;
    if (prev && !adjacent) {
      groups.push(current);
      current = [];
    }
    current.push(rc);
  }
  if (current.length) groups.push(current);

  const races = groups.map((grp, idx) => buildRaceMeta(header, grp, idx));

  // Two blocks can resolve to the same class (e.g. a mislabeled header with no
  // anchors). Race ids key all per-race UI state, so they must be unique.
  const seenIds = new Map();
  for (const race of races) {
    const n = (seenIds.get(race.id) ?? 0) + 1;
    seenIds.set(race.id, n);
    if (n > 1) {
      race.id += `-${n}`;
      race.className += ` (${n})`;
    }
  }
  return races;
}

function buildRaceMeta(header, rankCols, groupIdx) {
  const firstIdx = rankCols[0].index;
  const lastIdx  = rankCols[rankCols.length - 1].index;

  let anchorBefore = -1;
  for (let i = firstIdx - 1; i >= Math.max(0, firstIdx - ANCHOR_LOOKBACK); i--) {
    if (ANCHOR_BEFORE_RE.test(header[i])) { anchorBefore = i; break; }
  }
  let anchorAfter = -1;
  for (let i = lastIdx + 1; i < Math.min(header.length, lastIdx + 1 + ANCHOR_LOOKAHEAD); i++) {
    if (ANCHOR_AFTER_RE.test(header[i])) { anchorAfter = i; break; }
  }

  const classFromBefore = anchorBefore >= 0 ? extractClassYear(header[anchorBefore]) : null;
  const classFromAfter  = anchorAfter  >= 0 ? extractClassYear(header[anchorAfter])  : null;
  const classFromHeader = extractClassYear(rankCols[0].rawHeader);

  // Authoritative: prefer "balloted candidates" anchor, then write-in anchor,
  // then rank-header. Anchors describe the race; the rank header can be wrong.
  const classYear = classFromBefore ?? classFromAfter ?? classFromHeader ?? null;

  // Mismatch: any two sources disagreeing.
  const observed = [classFromBefore, classFromAfter, classFromHeader].filter(x => x != null);
  const unique = [...new Set(observed)];
  let headerClassMismatch = null;
  if (unique.length > 1) {
    headerClassMismatch =
      `Sources disagree on race class. "Balloted candidates" says ` +
      `${classFromBefore ?? "?"}, rank-column headers say ${classFromHeader ?? "?"}, ` +
      `write-in prompt says ${classFromAfter ?? "?"}. Using ${classYear} ` +
      `(trusted source: ${classFromBefore != null ? '"balloted candidates" prompt' : '"write-in" prompt'}).`;
  }

  return {
    id: classYear != null ? `class-${classYear}` : `race-${groupIdx + 1}`,
    className: classYear != null ? `Class of ${classYear}` : `Race ${groupIdx + 1}`,
    classYear,
    rankCols,
    writeInCol: anchorAfter,
    writeInHeader: anchorAfter >= 0 ? header[anchorAfter] : null,
    ballotedCandidatesText: anchorBefore >= 0 ? header[anchorBefore] : null,
    headerClassMismatch
  };
}

function extractClassYear(headerText) {
  if (!headerText) return null;
  const m = headerText.match(CLASS_RE);
  return m ? parseInt(m[1], 10) : null;
}

function buildRaceBallots(race, dataRows) {
  const ballots = [];
  const writeIns = [];
  const emptyBallotIndices = [];
  const candidateFirstSeen = new Map();

  dataRows.forEach((row, rowIdx) => {
    const seen = new Set();
    const ranking = [];
    for (const rc of race.rankCols) {
      const name = (row[rc.index] ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      ranking.push(name);
      if (!candidateFirstSeen.has(name)) {
        candidateFirstSeen.set(name, { row: rowIdx, rank: rc.rankNumber });
      }
    }
    if (ranking.length > 0) {
      ballots.push({ ranking, weight: 1, originalIndex: rowIdx + 2 });
    } else {
      emptyBallotIndices.push(rowIdx + 2);
    }
    if (race.writeInCol >= 0) {
      const raw = (row[race.writeInCol] ?? "").trim();
      if (raw) {
        writeIns.push({
          originalIndex: rowIdx + 2,
          rawText: raw,
          parsed: parseWriteInText(raw)
        });
      }
    }
  });

  race.ballots = ballots;
  race.writeIns = writeIns;
  race.emptyBallotIndices = emptyBallotIndices;
  race.candidates = [...candidateFirstSeen.keys()];
}

export function parseWriteInText(raw) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (/,\s*\d+\s*;/.test(cleaned) || /,\s*\d+\s*$/.test(cleaned)) {
    const parts = cleaned.split(/;|\band\b/i).map(p => p.trim()).filter(Boolean);
    const out = [];
    for (const part of parts) {
      const m = part.match(/^(.+?),\s*(\d+)\s*$/);
      if (m) out.push({ name: m[1].trim(), rank: parseInt(m[2], 10) });
    }
    if (out.length) return out;
  }
  const numbered = [...cleaned.matchAll(
    /(?:rank\s*)?(\d+)\s*[\.\):]\s*([A-Za-z][A-Za-z\-\.' ]+?)(?=\s*(?:(?:rank\s*)?\d+\s*[\.\):])|$)/gi
  )];
  if (numbered.length >= 1) {
    return numbered.map(m => ({ name: m[2].trim(), rank: parseInt(m[1], 10) }));
  }
  if (/^[A-Za-z][A-Za-z\-\.' ]+$/.test(cleaned)) {
    return [{ name: cleaned, rank: 1 }];
  }
  return null;
}
