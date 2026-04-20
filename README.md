# EPAC Ranked-Choice Counter

A browser-based Single Transferable Vote (STV) counter for Dartmouth's Student
Government elections, built for the Elections Planning Advisory Committee
(EPAC). Handles both:

- **Fall elections** — one ranked-choice race (freshman General Senator).
- **Spring elections** — three ranked-choice races (one General Senator race
  per continuing class), all in the same survey export.

Upload the raw Dartmouth survey export — no Google Sheets step — and get the
winners, round-by-round tally, and a downloadable audit log. Everything runs
in the browser; ballots never leave the uploader's laptop.

## What problem this solves

Before: export CSV → hand-edit in Sheets to extract rank columns and merge
write-ins → run an R script per race → read results in the console → hand-write
a summary. For Spring with three races, that's three separate R runs and
three manual merges.

After: drop the raw CSV into the page → the tool auto-detects how many races
are in it → configure each race (merges, write-ins, seats) via tabs → click
**Run all counts** → every race's result renders on one page with its own
round-by-round tally and downloadable audit log.

## Features

- **Auto-detects 1 or N races** — finds every rank column, groups contiguous
  blocks into separate races, and uses the adjacent "balloted candidates for
  the Class of XXXX..." prompt to identify each race's true class.
- **Cross-checks race identity** — the Spring 2025 export has rank columns
  labeled "Class of 2026" that actually belong to the Class of 2027 race. The
  tool detects this disagreement between sources and surfaces a warning
  banner so EPAC can confirm the race before counting.
- **Per-race configuration** — each race has its own merge suggestions,
  write-in review, candidate exclusions, and seat count. Switch between races
  with a tab bar; a single-race file hides the tabs entirely.
- **Write-in review** — every free-form write-in response is surfaced with an
  auto-parsed interpretation the admin confirms, rejects, or reassigns.
  Nothing is silently dropped or silently accepted.
- **Name normalization** — `"Willow Dubrovin"` and `"Willow DuBrovin"` are
  flagged as a likely merge for admin confirmation. Scoped per race.
- **Rerun-on-decline per race** — independent rerun controls for each race:
  - **Add a seat** (default EPAC workflow): increments `nseats` and recounts.
  - **Exclude candidates**: removes declined candidates from the ballots
    entirely and recounts with the same seat count.
- **Downloadable results** — CSV of all winners across all races + JSON audit
  log with every round, every transfer fraction, every event, for every race.
- **Privacy** — no server, no uploads, no tracking. Everything runs in the
  browser. You could run this entirely offline after first page load.

## Algorithm

Weighted Inclusive Gregory Method (WIGM) with **Droop quota**:

```
quota = floor(valid_ballots / (seats + 1)) + 1
```

Each ballot starts with weight 1.0. When a candidate reaches quota, they are
elected; their ballots' weights are multiplied by `(surplus / total)` and flow
to each voter's next-preferred remaining candidate. When no one reaches quota,
the lowest candidate is eliminated and their ballots transfer at full weight.

WIGM is the method used by Scottish local-government elections. Results should
match R's `vote::count.votes(method="stv")` in most cases; very tight
surplus-transfer situations can diverge by fractional amounts between STV
variants. The JSON audit log shows every transfer so any discrepancy can be
traced.

## How race detection works

The tool scans the CSV header for columns matching the pattern
`"Please rank the candidates ... - N"`. Then:

1. **Group contiguous rank columns** into blocks — a new block starts wherever
   either the column index jumps or the rank number resets.
2. **For each block, look up the race's true class** by scanning the columns
   immediately before and after:
   - The column before typically has `"The balloted candidates for the Class of
     XXXX General House Senator race include…"` — this is the authoritative
     source.
   - The column after typically has `"Please write in as many candidates as
     you wish for the Class of XXXX General House Senator race…"` — a good
     cross-check.
3. **Compare** against the "Class of XXXX" mentioned in the rank-column
   headers themselves. If the sources disagree, the tool uses the balloted-
   candidates anchor (empirically the most reliable) and flags the mismatch
   in the review screen as a warning banner.

This approach handled the Spring 2025 file correctly where rank columns 51–58
were labeled "Class of 2026" but actually belonged to the Class of 2027 race.

## Deployment — publish as a GitHub Pages site

### Option A: Brand-new repo

1. Create an empty GitHub repo (e.g. `epac-rcv`).
2. Copy every file from this folder into the repo root.
3. Commit and push to `main`.
4. In the repo, go to **Settings → Pages**.
5. Under **Source**, choose **Deploy from a branch**.
6. Set branch to `main` and folder to `/ (root)`. Save.
7. After a minute, the site publishes at
   `https://<your-username>.github.io/<repo-name>/`.

### Option B: Existing repo

Copy the files into a subfolder (e.g. `docs/`), push, and set Pages to serve
from `main` → `/docs`.

### File structure

```
.
├── index.html           the page itself
├── styles.css           styling
├── js/
│   ├── app.js           UI, per-race state, screen routing
│   ├── parse.js         CSV parse, multi-race detection, write-in parsing
│   ├── normalize.js     name-merge suggestions
│   └── stv.js           WIGM / Droop-quota STV algorithm
├── test/
│   └── stv.test.js      unit tests (run with `node --test`)
├── sample-data/
│   └── sample-ballots.csv   synthetic single-race example
├── .nojekyll            tells GitHub Pages not to Jekyll-process
├── LICENSE              MIT
└── README.md
```

## How to use

1. Open the published site.
2. Drop the raw Dartmouth CSV export.
3. **Review screen**:
   - If the file has multiple races, a tab bar appears. Click a tab to
     configure that race.
   - If a race was flagged with a header-class mismatch, a warning banner
     appears above its stats.
   - For each race: confirm merges, review write-ins, optionally exclude
     candidates, and set the seat count (default 2).
   - Click **Next race →** to proceed to the next tab, or **Run all counts** to
     count every race and move to results.
4. **Results screen**: winners for every race stacked top to bottom, each with
   its own round-by-round tally and rerun controls.
5. If a winner later declines:
   - Scroll to that race's section.
   - Click **Add a seat & re-count** to promote the next candidate (the "next
     best" person fills the extra seat).
   - Or check a candidate in **Exclude candidates** and click **Re-count with
     exclusions** for standard STV handling.
6. Download the CSV for records, or the JSON audit log for defensibility.

## Testing

Run the included tests with Node 18+:

```bash
node --test test/stv.test.js
```

Verified behavior:
- Fall 2025 file (1 race): `Class of 2029` → Daniel Sparks, Trace Ribble
- Spring 2025 file (3 races):
  - `Class of 2028` (323 ballots, 7 candidates) → Reece Sharp, Taha Tariq
  - `Class of 2027` (355 ballots, 8 candidates; header mismatch flagged)
    → Ikenna Nwafor, Tamia Kelly
  - `Class of 2026` (404 ballots, 2 candidates; trivial 2-for-2 race)
    → Farah Daredia, Md. Tamhidul Islam

## Extending

### A new race format

Edit `js/parse.js`. The regex `RANK_HEADER_RE` controls rank-column detection;
`ANCHOR_BEFORE_RE` and `ANCHOR_AFTER_RE` control race-boundary detection; and
`CLASS_RE` extracts the class year from the anchor columns. All are plain
patterns at the top of the file — change in ~30 seconds.

### Different seat counts per race

Already supported. Each race's seat count is independent on the review screen.

### A different STV variant (Meek, Scottish, etc.)

`js/stv.js` is self-contained (~200 lines). Swap for an alternative
implementation; the UI calls only
`runSTV({ ballots, candidates, seats, excluded })` and consumes a well-defined
result object.

## Previous R workflow, for reference

```r
library(vote)
raw <- read.csv("25F Election Results - version_for_r.csv")
final <- format_candidates_auto(raw, paste0("R", 1:17))
vote::count.votes(final, method = "stv", nseats = 9)
```

This tool produces equivalent winners for the same ballots, handles multi-race
Spring exports natively, and provides a visible audit trail without any
Sheets pre-processing.

## License

MIT — see `LICENSE`.
