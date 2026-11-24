// High scores and run records, kept in this browser only (localStorage): nothing leaves
// the device. Every finished run goes to the run log (the stats page sums it up); the
// score list holds the best KEEP runs saved with a name.
// A plain script (no modules), so the game also runs from a double-click on index.html: window.DeepRun.local.
window.DeepRun = window.DeepRun || {};
(() => {
"use strict";
const SCORES = "deeprun.scores", RUNS = "deeprun.runs";
const KEEP = 100; // saved scores kept
const MAX_RUNS = 3000; // runs in the log (the oldest go first): about 1 MB

function read(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** The saved scores, best first. */
function topScores() {
  return read(SCORES).filter((r) => r && Number.isFinite(r.score)).sort((a, b) => b.score - a.score);
}

/** Saves a run with its name; returns its place (1 = best, null = not among the kept) and the list. */
function addScore(run) {
  const entry = { ...run, name: String(run.name || "").trim().slice(0, 24) || "Anonymous", time: new Date().toISOString() };
  const top = [...topScores(), entry].sort((a, b) => b.score - a.score).slice(0, KEEP);
  if (!write(SCORES, top)) throw new Error("this browser doesn't keep data (private mode?)");
  const i = top.indexOf(entry);
  return { rank: i < 0 ? null : i + 1, top };
}

/** Records a finished run for the stats page. */
function recordRun(run) {
  write(RUNS, [...read(RUNS), run].slice(-MAX_RUNS));
}

/** The name typed after the run (it was recorded before): goes on the last run without one. */
function nameLastRun(name) {
  const runs = read(RUNS), last = runs.at(-1);
  if (!last || last.name || !name) return;
  last.name = String(name).slice(0, 40);
  write(RUNS, runs);
}

/** All recorded runs, oldest first. */
function allRuns() {
  return read(RUNS).filter((r) => r && typeof r.time === "string");
}

/** Deletes the scores and the run log. */
function clearAll() {
  try { localStorage.removeItem(SCORES); localStorage.removeItem(RUNS); localStorage.removeItem("deeprun.best"); } catch { /* nothing kept */ }
}

DeepRun.local = { topScores, addScore, recordRun, nameLastRun, allRuns, clearAll };
})();
