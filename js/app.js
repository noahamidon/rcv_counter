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
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
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
      for (const race of state.parsed.races) {
        state.raceState.set(race.id, {
          merges: new Map(),
          writeInAssignments: new Map(),
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

function ballotsForRace(raceId) {
  const race = getRaceById(raceId);
  const rs = state.raceState.get(raceId);
  if (!race || !rs) return [];

  let ballots = race.ballots.map(b => ({
    ranking: [...b.ranking], weight: 1, originalIndex: b.originalIndex
  }));

  const mergeMap = Object.fromEntries(rs.merges);
  ballots = applyMerges(ballots, mergeMap);
  ballots = dedupeRankings(ballots);

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

    namesToAdd = namesToAdd.map(n => mergeMap[n] ?? n);

    let ballot = ballots.find(b => b.originalIndex === originalIndex);
    if (!ballot) {
      ballot = { ranking: [], weight: 1, originalIndex };
      ballots.push(ballot);
    }
    for (const n of namesToAdd) {
      if (!ballot.ranking.includes(n)) ballot.ranking.push(n);
    }
  }
  return ballots.filter(b => b.ranking.length > 0);
}

function candidatesForRace(raceId) {
  const set = new Set();
  for (const b of ballotsForRace(raceId)) for (const n of b.ranking) set.add(n);
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
  for (const race of state.parsed.races) {
    const rs = state.raceState.get(race.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "race-tab" + (race.id === state.activeRaceId ? " active" : "");
    btn.innerHTML = `
      <span class="race-tab-year">${race.classYear ?? "?"}</span>
      <span class="race-tab-label">${escapeHtml(race.className)}</span>
      <span class="race-tab-count">${race.ballots.length} ballots · ${race.candidates.length} cands${rs.result ? " · ✓ counted" : ""}</span>
    `;
    btn.addEventListener("click", () => {
      state.activeRaceId = race.id;
      renderReview();
    });
    container.appendChild(btn);
  }
}

// ───── Review screen (for active race) ─────
function renderReview() {
  const race = activeRace();
  if (!race) return;
  const rs = activeRaceState();

  renderRaceTabs();
  renderRaceBanner();

  document.getElementById("stat-ballots").textContent = race.ballots.length;
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
    nextBtn.classList.remove("hidden");
    nextBtn.disabled = !hasNext;
    nextBtn.textContent = hasNext
      ? `Next race (${state.parsed.races[idx + 1].className}) →`
      : "Last race";
    runBtn.textContent = "Run all counts →";
  } else {
    nextBtn.classList.add("hidden");
    runBtn.textContent = "Run the count →";
  }
}

function renderRaceBanner() {
  const race = activeRace();
  const banner = document.getElementById("race-banner");
  const title = document.getElementById("review-screen-title");

  if (state.parsed.races.length > 1) {
    title.textContent = `Configure · ${race.className}`;
  } else {
    title.textContent = "Confirm the ballot before counting.";
  }

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
  const candidates = candidatesForRace(race.id);
  const suggestions = suggestMerges(candidates);

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
          <div class="panel-sub" style="margin-top:4px; font-size:12px;">${sug.reason}</div>
        </div>
      </label>
    `;
    const cb = row.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) for (const v of variants) rs.merges.set(v, sug.canonical);
      else for (const v of variants) rs.merges.delete(v);
      renderCandidateList();
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

  const knownCandidates = candidatesForRace(race.id);

  for (const w of race.writeIns) {
    if (!rs.writeInAssignments.has(w.originalIndex)) {
      rs.writeInAssignments.set(w.originalIndex, w.parsed ? "__accept__" : "__drop__");
    }
    const currentAction = rs.writeInAssignments.get(w.originalIndex);

    const row = document.createElement("div");
    row.className = "writein-row";
    const parsedHint = w.parsed
      ? w.parsed.map(p => `#${p.rank} ${escapeHtml(p.name)}`).join(" · ")
      : "(couldn't auto-parse — choose Drop or Assign to existing candidate)";

    const opt = (val, label, enabled = true) => enabled
      ? `<option value="${escapeAttr(val)}" ${currentAction === val ? "selected" : ""}>${escapeHtml(label)}</option>`
      : "";

    row.innerHTML = `
      <div class="writein-row-num">Row ${w.originalIndex}</div>
      <div class="writein-text">
        <div class="raw-label">Raw response</div>
        "${escapeHtml(w.rawText)}"
        <div class="raw-label" style="margin-top:8px;">Auto-parse</div>
        <span class="mono">${parsedHint}</span>
      </div>
      <div class="writein-action">
        <select>
          ${opt("__drop__", "Drop (don't count)")}
          ${opt("__accept__", "Accept auto-parse", !!w.parsed)}
          ${knownCandidates.map(c => opt(c, `Assign #1 → ${c}`)).join("")}
        </select>
      </div>
    `;
    const select = row.querySelector("select");
    select.addEventListener("change", () => {
      rs.writeInAssignments.set(w.originalIndex, select.value);
      renderCandidateList();
      renderMergePanel();
      updateReviewStats();
      renderRaceTabs();  // tab counts may have changed
    });
    list.appendChild(row);
  }
}

function renderCandidateList() {
  const race = activeRace();
  const rs = activeRaceState();
  const list = document.getElementById("candidate-list");
  const ballots = ballotsForRace(race.id);
  const candidates = candidatesForRace(race.id);
  const firstPrefs = tallyFirstPreferences(ballots);

  const sorted = [...candidates].sort((a, b) => (firstPrefs.get(b) ?? 0) - (firstPrefs.get(a) ?? 0));
  list.innerHTML = "";
  for (const c of sorted) {
    const count = firstPrefs.get(c) ?? 0;
    const row = document.createElement("div");
    row.className = "cand-row";
    const excluded = rs.excluded.has(c);
    row.innerHTML = `
      <input type="checkbox" ${excluded ? "checked" : ""} title="Exclude from count" />
      <div class="cand-name ${excluded ? "excluded" : ""}">${escapeHtml(c)}</div>
      <div class="cand-tally">${count} first-pref</div>
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

function updateReviewStats() {
  const race = activeRace();
  document.getElementById("stat-ballots").textContent = ballotsForRace(race.id).length;
  document.getElementById("stat-candidates").textContent = candidatesForRace(race.id).length;
}

// ───── Seats control ─────
document.getElementById("seats-inc").addEventListener("click", () => {
  const rs = activeRaceState();
  rs.seats = Math.max(1, rs.seats + 1);
  document.getElementById("seats-input").value = rs.seats;
});
document.getElementById("seats-dec").addEventListener("click", () => {
  const rs = activeRaceState();
  rs.seats = Math.max(1, rs.seats - 1);
  document.getElementById("seats-input").value = rs.seats;
});
document.getElementById("seats-input").addEventListener("change", e => {
  const rs = activeRaceState();
  rs.seats = Math.max(1, parseInt(e.target.value || "1", 10));
  e.target.value = rs.seats;
});

// ───── Next race / back ─────
document.getElementById("next-race").addEventListener("click", () => {
  const idx = state.parsed.races.findIndex(r => r.id === state.activeRaceId);
  if (idx >= 0 && idx < state.parsed.races.length - 1) {
    state.activeRaceId = state.parsed.races[idx + 1].id;
    renderReview();
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
  try {
    for (const race of state.parsed.races) {
      runRaceCount(race.id);
    }
    renderResults();
    show("screen-results");
  } catch (err) {
    console.error(err);
    alert("Count failed: " + (err.message || String(err)));
  }
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
    <p class="result-meta">${summarizeAllResults()}</p>
  `;

  const wrap = document.getElementById("results-stack");
  wrap.innerHTML = "";
  for (const race of state.parsed.races) {
    wrap.appendChild(buildRaceResultsSection(race));
  }
}

function summarizeAllResults() {
  const chunks = [];
  for (const race of state.parsed.races) {
    const rs = state.raceState.get(race.id);
    const r = rs.result;
    if (!r) continue;
    chunks.push(`${race.className}: ${r.winners.join(", ")}`);
  }
  return chunks.join(" · ");
}

function buildRaceResultsSection(race) {
  const rs = state.raceState.get(race.id);
  const r = rs.result;
  const section = document.createElement("section");
  section.className = "race-result";
  section.id = `result-${race.id}`;

  if (!r) {
    section.innerHTML = `
      <div class="race-result-head">
        <div class="race-result-eyebrow">Class of ${race.classYear ?? "?"}</div>
        <h2 class="race-result-title">${escapeHtml(race.className)}</h2>
        <p class="race-result-meta">No count run.</p>
      </div>
    `;
    return section;
  }

  const mismatchBanner = race.headerClassMismatch
    ? `<div class="banner-warn small">Header-class disagreement: ${escapeHtml(race.headerClassMismatch)}</div>`
    : "";

  section.innerHTML = `
    <div class="race-result-head">
      <div class="race-result-eyebrow">Class of ${race.classYear ?? "?"}</div>
      <h2 class="race-result-title">${escapeHtml(race.className)}</h2>
      <p class="race-result-meta">
        ${r.totalBallots} ballots · Droop quota ${r.quota} · ${r.rounds.length} rounds ·
        ${r.exhaustedBallots} exhausted${r.excluded.length ? " · excluded: " + r.excluded.map(escapeHtml).join(", ") : ""}
      </p>
      ${mismatchBanner}
    </div>
    <div class="winners-board">${buildWinnersHTML(r)}</div>
    <details class="race-rounds" open>
      <summary>Round-by-round tally</summary>
      <div class="rounds-table-wrap">${buildRoundsTableHTML(r)}</div>
    </details>
    <div class="panel inner-panel">
      <div class="panel-head">
        <h3>Rerun for ${escapeHtml(race.className)}</h3>
        <p class="panel-sub">Use "Add a seat" if a winner declines and you need the next-best candidate. Use "Exclude" to drop a candidate entirely and recount fresh.</p>
      </div>
      <div class="rerun-grid">
        <div class="rerun-card">
          <div class="rerun-label">Current seats</div>
          <div class="rerun-value">${r.seats}</div>
          <button class="btn-primary btn-full" data-action="add-seat" data-race="${race.id}">+ Add a seat &amp; re-count</button>
        </div>
        <div class="rerun-card">
          <div class="rerun-label">Exclude candidates</div>
          <div class="exclusion-list" data-race="${race.id}">${buildExclusionListHTML(race.id)}</div>
          <button class="btn-secondary btn-full" data-action="apply-exclusions" data-race="${race.id}">Re-count with exclusions</button>
        </div>
      </div>
    </div>
  `;

  // Wire up the per-race buttons.
  section.querySelector('[data-action="add-seat"]').addEventListener("click", () => {
    const rs2 = state.raceState.get(race.id);
    rs2.seats += 1;
    try { runRaceCount(race.id); renderResults(); }
    catch (err) { rs2.seats -= 1; alert(err.message); }
  });
  section.querySelector('[data-action="apply-exclusions"]').addEventListener("click", () => {
    try { runRaceCount(race.id); renderResults(); }
    catch (err) { alert(err.message); }
  });
  for (const cb of section.querySelectorAll(`.exclusion-list input[type=checkbox]`)) {
    cb.addEventListener("change", () => {
      const name = cb.dataset.name;
      const rs2 = state.raceState.get(race.id);
      if (cb.checked) rs2.excluded.add(name); else rs2.excluded.delete(name);
    });
  }
  return section;
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
  for (const e of r.electedDetail) allCands.add(e.name);
  for (const e of r.eliminatedDetail) allCands.add(e.name);

  const winnerSet = new Set(r.winners);
  const orderedCands = [
    ...r.electedDetail.map(e => e.name),
    ...[...allCands].filter(c => !winnerSet.has(c)).sort((a, b) => peakTally(r, b) - peakTally(r, a))
  ];

  let html = '<table class="rounds-table"><thead><tr>';
  html += '<th class="name-col">Candidate</th>';
  for (const rd of r.rounds) html += `<th>R${rd.round}</th>`;
  html += '</tr></thead><tbody>';

  for (const cand of orderedCands) {
    html += `<tr><td class="name-col">${escapeHtml(cand)}</td>`;
    for (const rd of r.rounds) {
      const tallyMap = new Map(rd.tally);
      const val = tallyMap.get(cand);
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
  const race = getRaceById(raceId);
  const rs = state.raceState.get(raceId);
  const cands = candidatesForRace(raceId);
  const winnersSet = new Set(rs.result?.winners ?? []);
  return cands.map(c => `
    <label>
      <input type="checkbox" data-name="${escapeAttr(c)}" ${rs.excluded.has(c) ? "checked" : ""} />
      <span>${escapeHtml(c)}${winnersSet.has(c) ? ' <span class="mono" style="color:var(--forest);">(currently elected)</span>' : ""}</span>
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
  const lines = [];
  lines.push(`EPAC Ranked-Choice Counter`);
  lines.push(`Source file,${state.fileName ?? ""}`);
  lines.push(`Generated,${new Date().toISOString()}`);
  lines.push("");
  for (const race of state.parsed.races) {
    const rs = state.raceState.get(race.id);
    const r = rs.result;
    if (!r) continue;
    lines.push(`Race,${race.className}`);
    lines.push(`Total valid ballots,${r.totalBallots}`);
    lines.push(`Droop quota,${r.quota}`);
    lines.push(`Seats filled,${r.seats}`);
    lines.push(`Exhausted ballots,${r.exhaustedBallots}`);
    lines.push(`Excluded,"${r.excluded.join("; ")}"`);
    lines.push("");
    lines.push("Rank,Winner,Round elected,Vote-weight at election");
    r.electedDetail.forEach((w, i) => {
      lines.push(`${i + 1},"${w.name}",${w.round},${w.tally.toFixed(4)}`);
    });
    lines.push("");
    lines.push("Elimination order");
    lines.push("Round,Candidate,Tally");
    r.eliminatedDetail.forEach(e => {
      lines.push(`${e.round},"${e.name}",${e.tally.toFixed(4)}`);
    });
    lines.push("");
    lines.push("");
  }
  downloadBlob(lines.join("\n"), "text/csv", "epac-results.csv");
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

// ───── Escape helpers ─────
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
