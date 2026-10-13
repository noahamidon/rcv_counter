// app.js — UI state & screen wiring for 1-or-N STV races.
import { parseSurveyCsv } from "./parse.js";
import { suggestMerges, applyMerges, dedupeRankings } from "./normalize.js";
import { runSTV } from "./stv.js";

// ───── App state ─────
const state = {
  parsed: null,           // { header, totalRows, races: [...] }
  raceState: new Map(),   // raceId -> { merges, writeInAssignments, excluded, seats, result }
  activeRaceId: null,     // which tab is selected on the review screen
  fileName: null
};

function getRaceById(id) { return state.parsed?.races.find(r => r.id === id) ?? null; }
function activeRace() { return getRaceById(state.activeRaceId); }
function activeRaceState() { return state.raceState.get(state.activeRaceId); }

// ───── Screen routing ─────
function show(screenId) {
  document.querySelectorAll(".screen").forEach(el => el.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ───── Upload ─────
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadError = document.getElementById("upload-error");

function showUploadError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.remove("hidden");
}
function clearUploadError() {
  uploadError.textContent = "";
  uploadError.classList.add("hidden");
}

dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragging"); });
dropZone.addEventListener("dragleave", e => {
  // Ignore dragleave fired when moving between the zone's own children.
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("dragging");
});
dropZone.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragging");
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});
fileInput.addEventListener("change", e => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});

function handleFile(file) {
  clearUploadError();
  if (!file.name.toLowerCase().endsWith(".csv")) {
    showUploadError("File must be a .csv export.");
    return;
  }
  state.fileName = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state.parsed = parseSurveyCsv(reader.result);
      // Initialize per-race state.
      state.raceState.clear();
      // Write-in defaults are set here, not on first render, so a race whose
      // tab is never opened still counts its write-ins the same way.
      for (const race of state.parsed.races) {
        state.raceState.set(race.id, {
          merges: new Map(),
          writeInAssignments: new Map(
            race.writeIns.map(w => [w.originalIndex, w.parsed?.length ? "__accept__" : "__drop__"])
          ),
          excluded: new Set(),
          seats: 2,
          result: null
        });
      }
      state.activeRaceId = state.parsed.races[0].id;
      renderReview();
      show("screen-review");
    } catch (err) {
      console.error(err);
      showUploadError(err.message || String(err));
    }
  };
  reader.onerror = () => showUploadError("Couldn't read that file.");
  reader.readAsText(file);
}

// ───── Ballot utilities (per race) ─────
function tallyFirstPreferences(ballots) {
  const t = new Map();
  for (const b of ballots) {
    if (!b.ranking.length) continue;
    const c = b.ranking[0];
    t.set(c, (t.get(c) ?? 0) + 1);
  }
  return t;
}

// `applyMergeMap: false` gives the pre-merge view, which merge suggestions are
// computed from — otherwise an accepted merge would hide its own suggestion.
function ballotsForRace(raceId, { applyMergeMap = true } = {}) {
  const race = getRaceById(raceId);
  const rs = state.raceState.get(raceId);
  if (!race || !rs) return [];

  let ballots = race.ballots.map(b => ({
    ranking: [...b.ranking], weight: 1, originalIndex: b.originalIndex
  }));

  const mergeMap = applyMergeMap ? Object.fromEntries(rs.merges) : {};
  ballots = applyMerges(ballots, mergeMap);
  ballots = dedupeRankings(ballots);

  // Per EPAC rules a write-in voter puts their *entire* ranking (balloted
  // candidates included) in the write-in box, so a counted write-in replaces
  // whatever that row ranked in the rank columns rather than adding to it.
  for (const [originalIndex, action] of rs.writeInAssignments) {
    if (!action || action === "__drop__") continue;
    const parsedWriteIn = race.writeIns.find(w => w.originalIndex === originalIndex);
    if (!parsedWriteIn) continue;

    let namesToAdd = [];
    if (action === "__accept__") {
      if (parsedWriteIn.parsed) {
        namesToAdd = parsedWriteIn.parsed
          .slice().sort((a, b) => a.rank - b.rank)
          .map(p => (p.name || "").trim()).filter(n => n);
      }
    } else {
      namesToAdd = [action.trim()];
    }
    if (namesToAdd.length === 0) continue;

    const ranking = [...new Set(namesToAdd.map(n => mergeMap[n] ?? n))];
    const ballot = ballots.find(b => b.originalIndex === originalIndex);
    if (ballot) ballot.ranking = ranking;
    else ballots.push({ ranking, weight: 1, originalIndex });
  }
  return ballots.filter(b => b.ranking.length > 0);
}

function candidatesForRace(raceId, opts) {
  const set = new Set();
  for (const b of ballotsForRace(raceId, opts)) for (const n of b.ranking) set.add(n);
  return [...set];
}

// ───── Review screen: tab bar ─────
function renderRaceTabs() {
  const container = document.getElementById("race-tabs");
  if (!state.parsed || state.parsed.races.length < 2) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = "";
  state.parsed.races.forEach((race, i) => {
    const active = race.id === state.activeRaceId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "race-tab" + (active ? " active" : "");
    btn.setAttribute("aria-current", active ? "true" : "false");
    btn.innerHTML = `
      <span class="race-tab-year">${race.classYear ?? i + 1}</span>
      <span class="race-tab-label">${escapeHtml(race.className)}</span>
      <span class="race-tab-count">${plural(ballotsForRace(race.id).length, "ballot")} · ${plural(candidatesForRace(race.id).length, "candidate")}</span>
    `;
    btn.addEventListener("click", () => {
      state.activeRaceId = race.id;
      renderReview();
    });
    container.appendChild(btn);
  });
}

// ───── Review screen (for active race) ─────
// Every config change re-renders the whole screen: stats, tabs, write-in
// dropdowns and the candidate list all depend on merges + write-ins.
function renderReview() {
  const race = activeRace();
  if (!race) return;
  const rs = activeRaceState();

  renderRaceTabs();
  renderRaceBanner();

  document.getElementById("stat-ballots").textContent = ballotsForRace(race.id).length;
  document.getElementById("stat-empty").textContent = race.emptyBallotIndices.length;
  document.getElementById("stat-candidates").textContent = candidatesForRace(race.id).length;
  document.getElementById("stat-writeins").textContent = race.writeIns.length;

  renderMergePanel();
  renderWriteInPanel();
  renderCandidateList();

  document.getElementById("seats-input").value = rs.seats;

  // Sequential "Next race →" button behavior.
  const idx = state.parsed.races.findIndex(r => r.id === state.activeRaceId);
  const hasNext = idx >= 0 && idx < state.parsed.races.length - 1;
  const runBtn = document.getElementById("run-count");
  const nextBtn = document.getElementById("next-race");
  if (state.parsed.races.length > 1) {
    nextBtn.classList.toggle("hidden", !hasNext);
    if (hasNext) nextBtn.textContent = `Next: ${state.parsed.races[idx + 1].className} →`;
    runBtn.textContent = `Run all ${state.parsed.races.length} counts →`;
  } else {
    nextBtn.classList.add("hidden");
    runBtn.textContent = "Run the count →";
  }
}

function renderRaceBanner() {
  const race = activeRace();
  const banner = document.getElementById("race-banner");
  const title = document.getElementById("review-screen-title");

  title.textContent = state.parsed.races.length > 1
    ? `Configure · ${race.className}`
    : "Confirm the ballot before counting.";

  // Show header-mismatch warning if the rank headers disagreed with anchors.
  if (race.headerClassMismatch) {
    banner.classList.remove("hidden");
    banner.innerHTML = `
      <strong>Heads up:</strong> ${escapeHtml(race.headerClassMismatch)}
      Double-check this race's candidate list below.
    `;
  } else {
    banner.classList.add("hidden");
    banner.innerHTML = "";
  }
}

function renderMergePanel() {
  const race = activeRace();
  const rs = activeRaceState();
  const panel = document.getElementById("merge-panel");
  const list = document.getElementById("merge-list");
  const suggestions = suggestMerges(candidatesForRace(race.id, { applyMergeMap: false }));

  if (suggestions.length === 0) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  list.innerHTML = "";

  for (const sug of suggestions) {
    const variants = sug.variants.filter(v => v !== sug.canonical);
    const row = document.createElement("div");
    row.className = "merge-row";
    const checked = variants.every(v => rs.merges.get(v) === sug.canonical);
    row.innerHTML = `
      <label>
        <input type="checkbox" ${checked ? "checked" : ""} />
        <div>
          <div class="merge-variants">
            ${variants.map(v => `<span>"${escapeHtml(v)}"</span>`).join(` <span class="arrow">+</span> `)}
            <span class="arrow">→</span>
            <span class="merge-canonical">"${escapeHtml(sug.canonical)}"</span>
          </div>
          <div class="merge-reason">${escapeHtml(sug.reason)}</div>
        </div>
      </label>
    `;
    const cb = row.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) for (const v of variants) rs.merges.set(v, sug.canonical);
      else for (const v of variants) rs.merges.delete(v);
      renderReview();
    });
    list.appendChild(row);
  }
}

function renderWriteInPanel() {
  const race = activeRace();
  const rs = activeRaceState();
  const panel = document.getElementById("writein-panel");
  const list = document.getElementById("writein-list");

  if (race.writeIns.length === 0) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  list.innerHTML = "";

  const knownCandidates = candidatesForRace(race.id).sort((a, b) => a.localeCompare(b));

  // Rows that used the rank columns *and* wrote in broke the ballot rules.
  const rankedByRow = new Map(race.ballots.map(b => [b.originalIndex, b.ranking]));
  const conflicts = race.writeIns.filter(w => rankedByRow.has(w.originalIndex)).length;
  if (conflicts) {
    const note = document.createElement("div");
    note.className = "writein-conflict-summary";
    note.innerHTML = `<strong>${plural(conflicts, "voter")}</strong> both ranked candidates and wrote in, which the rules don't allow.
      By default the write-in is used as their full ballot and their rank-column choices are ignored. Review each flagged row below.`;
    list.appendChild(note);
  }

  for (const w of race.writeIns) {
    // An assigned name may since have been merged into its canonical form.
    const assigned = rs.writeInAssignments.get(w.originalIndex);
    const currentAction = rs.merges.get(assigned) ?? assigned;
    const canAccept = !!w.parsed?.length;
    const alsoRanked = rankedByRow.get(w.originalIndex);

    const row = document.createElement("div");
    row.className = "writein-row" + (alsoRanked ? " has-conflict" : "");
    const parsedHint = canAccept
      ? w.parsed.map(p => `#${p.rank} ${escapeHtml(p.name)}`).join(" · ")
      : "Couldn't auto-parse — drop it or assign it to a candidate.";

    const opt = (val, label) =>
      `<option value="${escapeHtml(val)}" ${currentAction === val ? "selected" : ""}>${escapeHtml(label)}</option>`;

    row.innerHTML = `
      <div class="writein-row-num">Row ${w.originalIndex}</div>
      <div class="writein-text">
        <div class="raw-label">Raw response</div>
        <div class="writein-raw">"${escapeHtml(w.rawText)}"</div>
        <div class="raw-label">Auto-parse</div>
        <span class="mono ${canAccept ? "" : "writein-unparsed"}">${parsedHint}</span>
        ${alsoRanked ? `
          <div class="writein-conflict">
            <span class="raw-label">Also ranked (rules violation)</span>
            <span class="mono">${alsoRanked.map((n, i) => `#${i + 1} ${escapeHtml(n)}`).join(" · ")}</span>
          </div>` : ""}
      </div>
      <div class="writein-action">
        <select aria-label="Action for write-in on row ${w.originalIndex}">
          ${opt("__drop__", alsoRanked ? "Ignore write-in (count ranked choices)" : "Drop (don't count)")}
          ${canAccept ? opt("__accept__", alsoRanked ? "Use write-in as ballot" : "Accept auto-parse") : ""}
          <optgroup label="Ballot is a single vote for">
            ${knownCandidates.map(c => opt(c, c)).join("")}
          </optgroup>
        </select>
      </div>
    `;
    const select = row.querySelector("select");
    select.addEventListener("change", () => {
      rs.writeInAssignments.set(w.originalIndex, select.value);
      renderReview();
    });
    list.appendChild(row);
  }
}

function renderCandidateList() {
  const race = activeRace();
  const rs = activeRaceState();
  const list = document.getElementById("candidate-list");
  const ballots = ballotsForRace(race.id);
  const firstPrefs = tallyFirstPreferences(ballots);

  const sorted = candidatesForRace(race.id)
    .sort((a, b) => (firstPrefs.get(b) ?? 0) - (firstPrefs.get(a) ?? 0) || a.localeCompare(b));
  list.innerHTML = "";
  for (const c of sorted) {
    const count = firstPrefs.get(c) ?? 0;
    const excluded = rs.excluded.has(c);
    const row = document.createElement("label");
    row.className = "cand-row";
    row.title = "Tick to exclude from the count";
    row.innerHTML = `
      <input type="checkbox" ${excluded ? "checked" : ""} />
      <span class="cand-name ${excluded ? "excluded" : ""}">${escapeHtml(c)}</span>
      <span class="cand-tally">${count} first-pref</span>
    `;
    const cb = row.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) rs.excluded.add(c);
      else rs.excluded.delete(c);
      renderCandidateList();
    });
    list.appendChild(row);
  }
}

// ───── Seats control ─────
const seatsInput = document.getElementById("seats-input");
function setSeats(n) {
  const rs = activeRaceState();
  rs.seats = Number.isFinite(n) ? Math.min(99, Math.max(1, Math.round(n))) : rs.seats;
  seatsInput.value = rs.seats;
}
document.getElementById("seats-inc").addEventListener("click", () => setSeats(activeRaceState().seats + 1));
document.getElementById("seats-dec").addEventListener("click", () => setSeats(activeRaceState().seats - 1));
seatsInput.addEventListener("change", () => setSeats(parseInt(seatsInput.value, 10)));

// ───── Next race / back ─────
document.getElementById("next-race").addEventListener("click", () => {
  const idx = state.parsed.races.findIndex(r => r.id === state.activeRaceId);
  if (idx >= 0 && idx < state.parsed.races.length - 1) {
    state.activeRaceId = state.parsed.races[idx + 1].id;
    renderReview();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});
document.getElementById("back-to-upload").addEventListener("click", () => {
  fileInput.value = "";
  show("screen-upload");
});
document.getElementById("back-to-review").addEventListener("click", () => {
  renderReview();
  show("screen-review");
});

// ───── Run all counts ─────
document.getElementById("run-count").addEventListener("click", () => {
  for (const race of state.parsed.races) {
    try {
      runRaceCount(race.id);
    } catch (err) {
      console.error(err);
      // Jump to the race that failed so it can be fixed right away.
      state.activeRaceId = race.id;
      renderReview();
      alert(`Count failed for ${race.className}: ${err.message || String(err)}`);
      return;
    }
  }
  renderResults();
  show("screen-results");
});

function runRaceCount(raceId) {
  const rs = state.raceState.get(raceId);
  const ballots = ballotsForRace(raceId);
  const candidates = candidatesForRace(raceId);
  rs.result = runSTV({
    ballots,
    candidates,
    seats: rs.seats,
    excluded: [...rs.excluded]
  });
}

// ───── Results: stacked, one per race ─────
function renderResults() {
  const head = document.getElementById("result-head");
  const fileLabel = state.fileName ? ` · <span class="mono">${escapeHtml(state.fileName)}</span>` : "";
  const raceCount = state.parsed.races.length;
  head.innerHTML = `
    <div class="result-eyebrow">Results${fileLabel}</div>
    <h1 class="result-title">${raceCount === 1 ? "Election count" : `${raceCount} elections counted`}</h1>
    ${raceCount > 1 ? buildSummaryHTML() : ""}
  `;

  const wrap = document.getElementById("results-stack");
  wrap.innerHTML = "";
  state.parsed.races.forEach((race, i) => {
    wrap.appendChild(buildRaceResultsSection(race, i));
  });
}

// One line per race, linking down to its section.
function buildSummaryHTML() {
  const rows = state.parsed.races.map(race => {
    const r = state.raceState.get(race.id).result;
    return `
      <li>
        <a href="#result-${escapeHtml(race.id)}">${escapeHtml(race.className)}</a>
        <span>${r ? r.winners.map(escapeHtml).join(", ") : "—"}</span>
      </li>`;
  });
  return `<ul class="result-summary">${rows.join("")}</ul>`;
}

function buildRaceResultsSection(race, index) {
  const rs = state.raceState.get(race.id);
  const r = rs.result;
  const raceCount = state.parsed.races.length;
  const section = document.createElement("section");
  section.className = "race-result";
  section.id = `result-${race.id}`;

  const eyebrow = raceCount > 1 ? `<div class="race-result-eyebrow">Race ${index + 1} of ${raceCount}</div>` : "";

  if (!r) {
    section.innerHTML = `
      <div class="race-result-head">
        ${eyebrow}
        <h2 class="race-result-title">${escapeHtml(race.className)}</h2>
        <p class="race-result-meta">No count run.</p>
      </div>
    `;
    return section;
  }

  const mismatchBanner = race.headerClassMismatch
    ? `<div class="banner-warn small">Header-class disagreement: ${escapeHtml(race.headerClassMismatch)}</div>`
    : "";

  const meta = [
    plural(r.totalBallots, "ballot"),
    `Droop quota ${r.quota}`,
    plural(r.rounds.length, "round"),
    `${r.exhaustedBallots} exhausted`
  ];
  if (r.excluded.length) meta.push(`excluded: ${r.excluded.map(escapeHtml).join(", ")}`);

  section.innerHTML = `
    <div class="race-result-head">
      ${eyebrow}
      <h2 class="race-result-title">${escapeHtml(race.className)}</h2>
      <p class="race-result-meta">${meta.join(" · ")}</p>
      ${mismatchBanner}
    </div>
    <div class="winners-board">${buildWinnersHTML(r)}</div>
    <details class="race-rounds" open>
      <summary>Round-by-round tally</summary>
      <div class="rounds-table-wrap">${buildRoundsTableHTML(r)}</div>
    </details>
    <div class="panel inner-panel">
      <div class="panel-head">
        <h3>Rerun ${escapeHtml(race.className)}</h3>
        <p class="panel-sub">Use "Add a seat" if a winner declines and you need the next-best candidate. Use "Exclude" to drop a candidate entirely and recount fresh.</p>
      </div>
      <div class="rerun-grid">
        <div class="rerun-card">
          <div class="rerun-label">Current seats</div>
          <div class="rerun-value">${r.seats}</div>
          <button class="btn-primary btn-full" type="button" data-action="add-seat">+ Add a seat &amp; re-count</button>
        </div>
        <div class="rerun-card">
          <div class="rerun-label">Exclude candidates</div>
          <div class="exclusion-list">${buildExclusionListHTML(race.id)}</div>
          <button class="btn-secondary btn-full" type="button" data-action="apply-exclusions">Re-count with exclusions</button>
        </div>
      </div>
    </div>
  `;

  // Wire up the per-race buttons. Exclusions are staged in the checkboxes and
  // only committed when "Re-count" is clicked, so a failed recount is a no-op.
  section.querySelector('[data-action="add-seat"]').addEventListener("click", () => {
    rerun(race.id, rs2 => { rs2.seats += 1; });
  });
  section.querySelector('[data-action="apply-exclusions"]').addEventListener("click", () => {
    const picked = [...section.querySelectorAll(".exclusion-list input:checked")].map(cb => cb.dataset.name);
    rerun(race.id, rs2 => { rs2.excluded = new Set(picked); });
  });
  return section;
}

// Apply a config change and recount; roll the change back if the count fails.
function rerun(raceId, mutate) {
  const rs = state.raceState.get(raceId);
  const saved = { seats: rs.seats, excluded: new Set(rs.excluded) };
  mutate(rs);
  try {
    runRaceCount(raceId);
  } catch (err) {
    Object.assign(rs, saved);
    alert(err.message || String(err));
    return;
  }
  renderResults();
  document.getElementById(`result-${raceId}`)?.scrollIntoView({ block: "start" });
}

function buildWinnersHTML(r) {
  return r.electedDetail.map((w, i) => `
    <div class="winner">
      <div class="winner-seat">${i + 1}</div>
      <div>
        <div class="winner-name">${escapeHtml(w.name)}</div>
        <div class="winner-meta">elected in round ${w.round}</div>
      </div>
      <div class="winner-stat">
        <strong>${w.tally.toFixed(2)}</strong><br/>
        vote-weight at election
      </div>
    </div>
  `).join("");
}

function buildRoundsTableHTML(r) {
  const allCands = new Set();
  for (const round of r.rounds) for (const [c] of round.tally) allCands.add(c);

  const winnerSet = new Set(r.winners);
  const orderedCands = [
    ...r.winners,
    ...[...allCands].filter(c => !winnerSet.has(c)).sort((a, b) => peakTally(r, b) - peakTally(r, a))
  ];

  let html = '<table class="rounds-table"><thead><tr>';
  html += '<th class="name-col">Candidate</th>';
  for (const rd of r.rounds) html += `<th>R${rd.round}</th>`;
  html += '</tr></thead><tbody>';

  for (const cand of orderedCands) {
    html += `<tr><td class="name-col">${escapeHtml(cand)}</td>`;
    for (const rd of r.rounds) {
      const val = new Map(rd.tally).get(cand);
      const electEvent = rd.events.find(e => (e.type === "elect" || e.type === "elect-default") && e.candidate === cand);
      const elimEvent  = rd.events.find(e => e.type === "eliminate" && e.candidate === cand);
      if (electEvent)     html += `<td class="status-elect">${(electEvent.tally ?? val ?? 0).toFixed(2)} ✓</td>`;
      else if (elimEvent) html += `<td class="status-eliminate">${(elimEvent.tally ?? val ?? 0).toFixed(2)}</td>`;
      else if (val === undefined) html += `<td class="status-inactive">—</td>`;
      else html += `<td>${val.toFixed(2)}</td>`;
    }
    html += '</tr>';
  }
  html += `<tr class="summary-row"><td class="name-col">Exhausted weight</td>`;
  for (const rd of r.rounds) html += `<td>${rd.exhaustedWeight.toFixed(2)}</td>`;
  html += `</tr>`;
  html += `<tr class="summary-row"><td class="name-col">Quota</td>`;
  for (const rd of r.rounds) html += `<td>${r.quota}</td>`;
  html += `</tr></tbody></table>`;
  return html;
}

function buildExclusionListHTML(raceId) {
  const rs = state.raceState.get(raceId);
  const winnersSet = new Set(rs.result?.winners ?? []);
  return candidatesForRace(raceId).map(c => `
    <label>
      <input type="checkbox" data-name="${escapeHtml(c)}" ${rs.excluded.has(c) ? "checked" : ""} />
      <span>${escapeHtml(c)}${winnersSet.has(c) ? ' <span class="elected-tag">elected</span>' : ""}</span>
    </label>
  `).join("");
}

function peakTally(result, candidate) {
  let peak = 0;
  for (const round of result.rounds)
    for (const [c, v] of round.tally) if (c === candidate && v > peak) peak = v;
  return peak;
}

// ───── Downloads ─────
document.getElementById("download-csv").addEventListener("click", () => {
  const rows = [
    ["EPAC Ranked-Choice Counter"],
    ["Source file", state.fileName ?? ""],
    ["Generated", new Date().toISOString()],
    []
  ];
  for (const race of state.parsed.races) {
    const r = state.raceState.get(race.id).result;
    if (!r) continue;
    rows.push(
      ["Race", race.className],
      ["Total valid ballots", r.totalBallots],
      ["Droop quota", r.quota],
      ["Seats filled", r.seats],
      ["Exhausted ballots", r.exhaustedBallots],
      ["Excluded", r.excluded.join("; ")],
      [],
      ["Rank", "Winner", "Round elected", "Vote-weight at election"],
      ...r.electedDetail.map((w, i) => [i + 1, w.name, w.round, w.tally.toFixed(4)]),
      [],
      ["Elimination order"],
      ["Round", "Candidate", "Tally"],
      ...r.eliminatedDetail.map(e => [e.round, e.name, e.tally.toFixed(4)]),
      [],
      []
    );
  }
  downloadBlob(rows.map(row => row.map(csvCell).join(",")).join("\n"), "text/csv", "epac-results.csv");
});

document.getElementById("download-json").addEventListener("click", () => {
  const racesData = state.parsed.races.map(race => {
    const rs = state.raceState.get(race.id);
    return {
      id: race.id,
      className: race.className,
      classYear: race.classYear,
      headerClassMismatch: race.headerClassMismatch,
      ballotedCandidatesText: race.ballotedCandidatesText,
      config: {
        seats: rs.seats,
        excluded: [...rs.excluded],
        merges: Object.fromEntries(rs.merges),
        writeInAssignments: Object.fromEntries(rs.writeInAssignments)
      },
      totalBallotsParsed: race.ballots.length,
      emptyRows: race.emptyBallotIndices.length,
      candidates: candidatesForRace(race.id),
      result: rs.result
    };
  });
  const audit = {
    tool: "EPAC Ranked-Choice Counter",
    version: "1.1.0",
    algorithm: "Weighted Inclusive Gregory Method (WIGM), Droop quota",
    generatedAt: new Date().toISOString(),
    sourceFile: state.fileName,
    totalSurveyRows: state.parsed.totalRows,
    races: racesData
  };
  const json = JSON.stringify(audit, (k, v) => v instanceof Map ? Object.fromEntries(v) : v, 2);
  downloadBlob(json, "application/json", "epac-audit.json");
});

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ───── Formatting helpers ─────
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }
