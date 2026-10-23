(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const peopleBody = $('peopleTable').querySelector('tbody');
  const reportBody = $('reportPreviewTable').querySelector('tbody');
  const estimateBody = $('estimatesTable').querySelector('tbody');
  let people = [];
  let lastResult = null;
  let showAllReports = false;
  let estimateSortDescending = true;
  let lastIncentiveResult = null;

  const DEFAULTS = {
    n: 24, K: 4, probes: 6, seed: 42, mu: 70, gamma: 0.04,
    scoreMin: 0, scoreMax: 100, scoreDistribution: 'normal', clampReports: false,
    biasMax: 8, biasDistribution: 'uniform', tauMin: 0.02, tauMax: 1.5,
    alpha: 1, competitiveWeight: 0.02
  };
  const METHOD_ORDER = ['PEQA', 'Median', 'Mean', 'ERM'];
  const METHOD_COLORS = { PEQA: '#138f80', Median: '#4e79d9', Mean: '#d49a38', ERM: '#8868cb' };

  function makeRng(seed) {
    let a = (Number(seed) || 0) >>> 0;
    return {
      next() { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
      normal() { let u = 0, v = 0; while (u === 0) u = this.next(); while (v === 0) v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
      shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
    };
  }
  const num = (id) => Number($(id).value);
  const int = (id) => parseInt($(id).value, 10);
  const fmt = (x, digits = 2) => Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const fmtSigned = (x, digits = 2) => Number.isFinite(x) ? `${x > 0 ? '+' : ''}${fmt(x, digits)}` : '—';
  const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  function blankPerson(id) { return { id, score: '', probe: 'auto', bias: '', tau: '' }; }
  function resizePeople(n) {
    const old = new Map(people.map(p => [p.id, p]));
    people = Array.from({ length: n }, (_, i) => old.get(i + 1) || blankPerson(i + 1));
    renderPeopleTable();
    $('dataTabCount').textContent = String(n);
    if (lastResult && lastResult.data.n !== n) markResultsStale();
  }

  function readConfig() {
    return {
      n: int('nStudents'), K: int('papersPerGrader'), probes: int('probeCount'), seed: int('randomSeed'),
      mu: num('priorMean'), gamma: num('priorPrecision'), scoreMin: num('scoreMin'), scoreMax: num('scoreMax'),
      clampReports: $('clampReports').checked, scoreDistribution: $('scoreDistribution').value, biasMax: num('biasMax'), biasDistribution: $('biasDistribution').value,
      tauMin: num('reliabilityMin'), tauMax: num('reliabilityMax'), alpha: num('alpha'), competitiveWeight: num('competitiveWeight')
    };
  }
  function applyConfig(c) {
    $('nStudents').value = c.n ?? DEFAULTS.n;
    $('papersPerGrader').value = String(c.K ?? DEFAULTS.K);
    $('probeCount').value = c.probes ?? DEFAULTS.probes;
    $('randomSeed').value = c.seed ?? DEFAULTS.seed;
    $('priorMean').value = c.mu ?? DEFAULTS.mu;
    $('priorPrecision').value = c.gamma ?? DEFAULTS.gamma;
    $('scoreMin').value = c.scoreMin ?? DEFAULTS.scoreMin;
    $('scoreMax').value = c.scoreMax ?? DEFAULTS.scoreMax;
    $('clampReports').checked = Boolean(c.clampReports ?? DEFAULTS.clampReports);
    $('scoreDistribution').value = c.scoreDistribution ?? DEFAULTS.scoreDistribution;
    $('biasMax').value = c.biasMax ?? DEFAULTS.biasMax;
    $('biasDistribution').value = c.biasDistribution ?? DEFAULTS.biasDistribution;
    $('reliabilityMin').value = c.tauMin ?? DEFAULTS.tauMin;
    $('reliabilityMax').value = c.tauMax ?? DEFAULTS.tauMax;
    $('alpha').value = c.alpha ?? DEFAULTS.alpha;
    $('competitiveWeight').value = c.competitiveWeight ?? DEFAULTS.competitiveWeight;
    resizePeople(clamp(parseInt($('nStudents').value, 10) || DEFAULTS.n, 1, 150));
    updateConstraints();
  }

  function validateConfig(c, rowData = people) {
    const issues = [];
    if (!Number.isInteger(c.n) || c.n < 6 || c.n > 150) issues.push('Students/papers must be an integer from 6 to 150.');
    if (![4, 6, 8].includes(c.K)) issues.push('K must be 4, 6, or 8.');
    const q = c.K / 2;
    if (!Number.isInteger(c.probes) || c.probes < q + 1) issues.push(`Probe count ℓ must be at least ${q + 1} for K=${c.K} when self-grading is forbidden.`);
    if (Number.isInteger(c.probes) && c.probes > Math.floor(c.n / (q + 1))) issues.push(`Probe count ℓ must be at most ${Math.floor(c.n / (q + 1))} for the paper's assignment bound.`);
    if (!(Number.isFinite(c.gamma) && c.gamma > 0)) issues.push('Prior precision γ must be positive.');
    if (!(Number.isFinite(c.tauMin) && Number.isFinite(c.tauMax) && c.tauMin > 0 && c.tauMax >= c.tauMin)) issues.push('Reliability bounds must be positive and maximum τ must be ≥ minimum τ.');
    if (!(Number.isFinite(c.scoreMin) && Number.isFinite(c.scoreMax) && c.scoreMax > c.scoreMin)) issues.push('Maximum score must be greater than minimum score.');
    if (!Number.isFinite(c.mu)) issues.push('Prior mean μ must be a number.');
    if (!(Number.isFinite(c.biasMax) && c.biasMax >= 0)) issues.push('Bias range must be zero or positive.');
    if (!(Number.isFinite(c.alpha) && c.alpha >= 0)) issues.push('Performance weight α must be zero or positive.');
    if (!(Number.isFinite(c.competitiveWeight) && c.competitiveWeight >= 0)) issues.push('Competitive weight w must be zero or positive.');
    if (!Number.isFinite(c.seed)) issues.push('Random seed must be a number.');
    let pinnedProbe = 0, pinnedNon = 0;
    rowData.forEach((p, i) => {
      if (p.probe === 'probe') pinnedProbe++;
      if (p.probe === 'nonprobe') pinnedNon++;
      const score = String(p.score ?? '').trim();
      const bias = String(p.bias ?? '').trim();
      const tau = String(p.tau ?? '').trim();
      if (score && !Number.isFinite(Number(score))) issues.push(`Student ${i + 1}: true score must be a number or blank.`);
      else if (score && (Number(score) < c.scoreMin || Number(score) > c.scoreMax)) issues.push(`Student ${i + 1}: true score must lie between ${c.scoreMin} and ${c.scoreMax}.`);
      if (bias && !Number.isFinite(Number(bias))) issues.push(`Student ${i + 1}: bias must be a number or blank.`);
      if (tau && !(Number.isFinite(Number(tau)) && Number(tau) > 0)) issues.push(`Student ${i + 1}: reliability τ must be positive or blank.`);
    });
    if (pinnedProbe > c.probes) issues.push(`${pinnedProbe} people are forced to be probes, but ℓ=${c.probes}.`);
    if (pinnedNon > c.n - c.probes) issues.push(`${pinnedNon} people are forced to be non-probes, but only ${c.n - c.probes} non-probe papers are allowed.`);
    return issues;
  }
  function updateConstraints() {
    const c = readConfig();
    const q = c.K / 2;
    $('probeCount').min = Number.isFinite(q) ? q + 1 : 3;
    $('probeCount').max = Number.isFinite(c.n) && Number.isFinite(q) ? Math.floor(c.n / (q + 1)) : 150;
    const issues = validateConfig(c, people);
    const box = $('constraintBox');
    if (issues.length) {
      box.classList.add('invalid'); box.innerHTML = `<span class="constraint-icon">!</span><span>${safe(issues[0])}</span>`;
    } else {
      box.classList.remove('invalid');
      box.innerHTML = `<span class="constraint-icon">✓</span><span>Valid range: ℓ=${q + 1}–${Math.floor(c.n / (q + 1))}; currently ${c.probes} probe papers and K=${c.K} assignments per grader.</span>`;
    }
  }

  function renderPeopleTable() {
    peopleBody.innerHTML = people.map((p, i) => {
      const tau = String(p.tau ?? '').trim();
      const noise = tau && Number(tau) > 0 ? fmt(1 / Math.sqrt(Number(tau)), 3) : 'Auto';
      return `<tr data-person-row="${i}">
        <td>ST-${String(p.id).padStart(3, '0')}</td>
        <td><input aria-label="True score for student ${p.id}" data-index="${i}" data-field="score" class="${String(p.score).trim() ? '' : 'auto-cell'}" type="number" step="any" min="${safe(readConfig().scoreMin)}" max="${safe(readConfig().scoreMax)}" placeholder="Auto" value="${safe(p.score)}"></td>
        <td><select aria-label="Probe status for student ${p.id}" data-index="${i}" data-field="probe"><option value="auto" ${p.probe === 'auto' ? 'selected' : ''}>Auto</option><option value="probe" ${p.probe === 'probe' ? 'selected' : ''}>Probe</option><option value="nonprobe" ${p.probe === 'nonprobe' ? 'selected' : ''}>Non-probe</option></select></td>
        <td><input aria-label="Bias for grader ${p.id}" data-index="${i}" data-field="bias" class="${String(p.bias).trim() ? '' : 'auto-cell'}" type="number" step="any" placeholder="Auto" value="${safe(p.bias)}"></td>
        <td><input aria-label="Reliability for grader ${p.id}" data-index="${i}" data-field="tau" class="${tau ? '' : 'auto-cell'}" type="number" min="0.000001" step="any" placeholder="Auto" value="${safe(p.tau)}"></td>
        <td class="number-cell">${noise}</td>
      </tr>`;
    }).join('');
    $('dataTabCount').textContent = String(people.length);
  }

  function generatePeopleFromConfig(c, rng, sourceRows = people) {
    return sourceRows.map((p, i) => {
      const scoreText = String(p.score ?? '').trim();
      const biasText = String(p.bias ?? '').trim();
      const tauText = String(p.tau ?? '').trim();
      let trueScore;
      if (scoreText) trueScore = Number(scoreText);
      else trueScore = c.scoreDistribution === 'uniform' ? c.scoreMin + rng.next() * (c.scoreMax - c.scoreMin) : clamp(c.mu + rng.normal() / Math.sqrt(c.gamma), c.scoreMin, c.scoreMax);
      let bias;
      if (biasText) bias = Number(biasText);
      else if (c.biasDistribution === 'normal') bias = rng.normal() * c.biasMax / 2;
      else bias = (rng.next() * 2 - 1) * c.biasMax;
      let tau;
      if (tauText) tau = Number(tauText);
      else tau = c.tauMin + rng.next() * (c.tauMax - c.tauMin);
      return { id: i + 1, trueScore, bias, tau, probeOverride: p.probe || 'auto' };
    });
  }

  function chooseProbes(c, rows, rng) {
    const forcedProbe = rows.map((p, i) => p.probeOverride === 'probe' ? i : -1).filter(i => i >= 0);
    const forcedNon = new Set(rows.map((p, i) => p.probeOverride === 'nonprobe' ? i : -1).filter(i => i >= 0));
    const available = rows.map((p, i) => i).filter(i => !forcedNon.has(i) && !forcedProbe.includes(i));
    const need = c.probes - forcedProbe.length;
    if (need < 0 || need > available.length) throw new Error('Probe overrides conflict with the target probe count.');
    rng.shuffle(available);
    return new Set([...forcedProbe, ...available.slice(0, need)]);
  }

  class Dinic {
    constructor(n) { this.g = Array.from({ length: n }, () => []); this.level = Array(n).fill(-1); this.it = Array(n).fill(0); }
    addEdge(from, to, cap) {
      const f = { to, rev: this.g[to].length, cap, initial: cap };
      const r = { to: from, rev: this.g[from].length, cap: 0, initial: 0 };
      this.g[from].push(f); this.g[to].push(r); return f;
    }
    bfs(s, t) {
      this.level.fill(-1); this.level[s] = 0; const q = [s];
      for (let h = 0; h < q.length; h++) {
        const v = q[h];
        for (const e of this.g[v]) if (e.cap > 0 && this.level[e.to] < 0) { this.level[e.to] = this.level[v] + 1; q.push(e.to); }
      }
      return this.level[t] >= 0;
    }
    dfs(v, t, f) {
      if (v === t) return f;
      for (; this.it[v] < this.g[v].length; this.it[v]++) {
        const e = this.g[v][this.it[v]];
        if (e.cap <= 0 || this.level[v] + 1 !== this.level[e.to]) continue;
        const d = this.dfs(e.to, t, Math.min(f, e.cap));
        if (d > 0) { e.cap -= d; this.g[e.to][e.rev].cap += d; return d; }
      }
      return 0;
    }
    maxFlow(s, t) {
      let flow = 0;
      while (this.bfs(s, t)) { this.it.fill(0); let f; while ((f = this.dfs(s, t, 1e9)) > 0) flow += f; }
      return flow;
    }
  }

  function createAssignment(c, probeSet, rng) {
    const n = c.n, q = c.K / 2;
    const probes = [...probeSet];
    const nonprobes = Array.from({ length: n }, (_, i) => i).filter(i => !probeSet.has(i));
    const assignmentsByGrader = Array.from({ length: n }, () => []);
    const gradersByPaper = Array.from({ length: n }, () => []);
    const probeLoads = Array(n).fill(0);
    // Give every grader q distinct probe papers, balancing loads and excluding self-grading.
    const graderOrder = rng.shuffle(Array.from({ length: n }, (_, i) => i));
    for (const g of graderOrder) {
      const eligible = probes.filter(p => p !== g);
      rng.shuffle(eligible);
      eligible.sort((a, b) => probeLoads[a] - probeLoads[b]);
      if (eligible.length < q) throw new Error(`Not enough eligible probe papers for grader ${g + 1}. Increase ℓ.`);
      for (const p of eligible.slice(0, q)) { assignmentsByGrader[g].push(p); gradersByPaper[p].push(g); probeLoads[p]++; }
    }
    // Every non-probe receives q or q+1 graders, with exactly nq total edges and no self-grading.
    const extraSlots = c.probes * q;
    if (extraSlots > nonprobes.length) throw new Error('Infeasible non-probe load bound; reduce ℓ or K.');
    let success = false;
    for (let attempt = 0; attempt < 30 && !success; attempt++) {
      const high = new Set(rng.shuffle([...nonprobes]).slice(0, extraSlots));
      const paperCap = new Map(nonprobes.map(p => [p, q + (high.has(p) ? 1 : 0)]));
      const source = 0, graderBase = 1, paperBase = 1 + n, sink = paperBase + n;
      const net = new Dinic(sink + 1);
      const refs = Array.from({ length: n }, () => new Map());
      for (let g = 0; g < n; g++) net.addEdge(source, graderBase + g, q);
      for (const p of nonprobes) net.addEdge(paperBase + p, sink, paperCap.get(p));
      for (let g = 0; g < n; g++) {
        const ordered = rng.shuffle([...nonprobes]);
        for (const p of ordered) if (p !== g) refs[g].set(p, net.addEdge(graderBase + g, paperBase + p, 1));
      }
      const flow = net.maxFlow(source, sink);
      if (flow === n * q) {
        for (let g = 0; g < n; g++) for (const [p, edge] of refs[g]) if (edge.cap === 0) { assignmentsByGrader[g].push(p); gradersByPaper[p].push(g); }
        success = true;
      }
    }
    if (!success) throw new Error('Could not construct the constrained assignment. Try a larger population or a smaller K.');
    assignmentsByGrader.forEach((arr, g) => { arr.sort((a, b) => a - b); if (new Set(arr).size !== arr.length) throw new Error(`Duplicate paper assignment for grader ${g + 1}.`); });
    const loads = nonprobes.map(p => gradersByPaper[p].length);
    const checks = {
      everyGraderHasK: assignmentsByGrader.every(a => a.length === c.K),
      probesPerGrader: assignmentsByGrader.every(a => a.filter(p => probeSet.has(p)).length === q),
      nonprobesPerGrader: assignmentsByGrader.every(a => a.filter(p => !probeSet.has(p)).length === q),
      noSelfGrading: assignmentsByGrader.every((a, g) => !a.includes(g)),
      nonprobeCoverage: loads.every(k => k >= q && k <= q + 1),
      allPapersAssigned: gradersByPaper.every((gs, p) => gs.length > 0),
      noDuplicates: assignmentsByGrader.every(a => new Set(a).size === a.length)
    };
    if (Object.values(checks).some(v => !v)) throw new Error('Generated assignment failed a validation check. Change the seed or parameters and retry.');
    return { assignmentsByGrader, gradersByPaper, checks, probeLoads, nonprobeLoads: nonprobes.map(p => gradersByPaper[p].length), nonprobes };
  }

  function createNoiseMatrix(data, rng) {
    const z = Array.from({ length: data.n }, () => Array(data.n).fill(null));
    data.assignmentsByGrader.forEach((papers, g) => papers.forEach(p => { z[g][p] = rng.normal(); }));
    return z;
  }
  function buildReports(c, data, z, overrideIndex = -1, overrideTau = null) {
    const reports = Array.from({ length: c.n }, () => Array(c.n).fill(null));
    data.assignmentsByGrader.forEach((papers, g) => {
      const tau = g === overrideIndex ? overrideTau : data.people[g].tau;
      papers.forEach(p => {
        let y = data.people[p].trueScore + data.people[g].bias + z[g][p] / Math.sqrt(tau);
        if (c.clampReports) y = clamp(y, c.scoreMin, c.scoreMax);
        reports[g][p] = y;
      });
    });
    return reports;
  }
  function estimateTraits(c, data, reports) {
    return data.people.map((person, g) => {
      const probePapers = data.assignmentsByGrader[g].filter(p => data.probeSet.has(p));
      const diffs = probePapers.map(p => reports[g][p] - data.people[p].trueScore);
      const bHat = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
      const sse = diffs.reduce((a, d) => a + (d - bHat) ** 2, 0);
      // The paper's estimator is (|P_i|-1)/SSE. Cap numerical infinities only for stable display/weighting.
      const tauHat = sse <= 1e-12 ? 1e6 : clamp((probePapers.length - 1) / sse, 1e-6, 1e6);
      return { id: person.id, bHat, tauHat, probeCount: probePapers.length, sse };
    });
  }
  function median(values) {
    if (!values.length) return NaN;
    const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function aggregatePEQA(c, data, reports, estimates, paper, excludedGrader = -1) {
    let numerator = Math.sqrt(c.gamma) * c.mu;
    let denominator = Math.sqrt(c.gamma);
    for (const g of data.gradersByPaper[paper]) {
      if (g === excludedGrader) continue;
      const w = Math.sqrt(estimates[g].tauHat);
      numerator += w * (reports[g][paper] - estimates[g].bHat);
      denominator += w;
    }
    let value = denominator > 0 ? numerator / denominator : c.mu;
    if (c.clampReports) value = clamp(value, c.scoreMin, c.scoreMax);
    return value;
  }
  function aggregateERM(c, data, reports, estimates, paper) {
    let numerator = c.gamma * c.mu, denominator = c.gamma;
    for (const g of data.gradersByPaper[paper]) {
      const w = estimates[g].tauHat;
      numerator += w * (reports[g][paper] - estimates[g].bHat); denominator += w;
    }
    let value = denominator > 0 ? numerator / denominator : c.mu;
    if (c.clampReports) value = clamp(value, c.scoreMin, c.scoreMax);
    return value;
  }
  function scoreMechanisms(c, data, reports, estimates) {
    const scores = { PEQA: Array(c.n), Median: Array(c.n), Mean: Array(c.n), ERM: Array(c.n) };
    for (let p = 0; p < c.n; p++) {
      if (data.probeSet.has(p)) { for (const m of METHOD_ORDER) scores[m][p] = data.people[p].trueScore; continue; }
      const vals = data.gradersByPaper[p].map(g => reports[g][p]);
      scores.PEQA[p] = aggregatePEQA(c, data, reports, estimates, p);
      scores.ERM[p] = aggregateERM(c, data, reports, estimates, p);
      scores.Median[p] = median(vals);
      scores.Mean[p] = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
      if (c.clampReports) {
        scores.Median[p] = clamp(scores.Median[p], c.scoreMin, c.scoreMax);
        scores.Mean[p] = clamp(scores.Mean[p], c.scoreMin, c.scoreMax);
      }
    }
    return scores;
  }
  function calculatePerformance(c, data, reports, estimates, scores) {
    const t = Array(c.n).fill(0);
    const contributionCount = Array(c.n).fill(0);
    for (let p = 0; p < c.n; p++) {
      if (data.probeSet.has(p)) continue;
      const truth = data.people[p].trueScore;
      const withReward = -((scores.PEQA[p] - truth) ** 2);
      for (const g of data.gradersByPaper[p]) {
        const without = aggregatePEQA(c, data, reports, estimates, p, g);
        const withoutReward = -((without - truth) ** 2);
        t[g] += c.alpha * (withReward - withoutReward);
        contributionCount[g]++;
      }
    }
    return { t, contributionCount };
  }
  function scoreMetrics(c, data, scores) {
    const papers = data.paperOrder.filter(p => !data.probeSet.has(p));
    const metrics = {};
    for (const method of METHOD_ORDER) {
      const errs = papers.map(p => scores[method][p] - data.people[p].trueScore);
      const mse = errs.reduce((s, e) => s + e * e, 0) / Math.max(1, errs.length);
      metrics[method] = { mse, rmse: Math.sqrt(mse), mae: errs.reduce((s, e) => s + Math.abs(e), 0) / Math.max(1, errs.length), bias: errs.reduce((s, e) => s + e, 0) / Math.max(1, errs.length), n: errs.length };
    }
    return metrics;
  }

  function evaluateScenario(c, data, z, overrideIndex = -1, overrideTau = null) {
    const reports = buildReports(c, data, z, overrideIndex, overrideTau);
    const estimates = estimateTraits(c, data, reports);
    const scores = scoreMechanisms(c, data, reports, estimates);
    const performance = calculatePerformance(c, data, reports, estimates, scores);
    const finalScores = scores.PEQA.map((score, p) => data.probeSet.has(p) ? data.people[p].trueScore : Math.max(score, data.people[p].trueScore));
    const totals = finalScores.map((s, i) => s + performance.t[i]);
    const totalAll = totals.reduce((a, b) => a + b, 0);
    const utilities = totals.map((v, i) => v - c.competitiveWeight * (totalAll - v));
    return { reports, estimates, scores, performance, finalScores, totals, utilities };
  }

  function constructExperiment(c, rows) {
    const issues = validateConfig(c, rows);
    if (issues.length) throw new Error(issues[0]);
    const rng = makeRng(c.seed);
    const peopleResolved = generatePeopleFromConfig(c, rng, rows);
    const probes = chooseProbes(c, peopleResolved, rng);
    const assignment = createAssignment(c, probes, rng);
    const data = {
      n: c.n, people: peopleResolved, probeSet: probes, paperOrder: Array.from({ length: c.n }, (_, i) => i),
      assignmentsByGrader: assignment.assignmentsByGrader, gradersByPaper: assignment.gradersByPaper,
      assignmentChecks: assignment.checks, probeLoads: assignment.probeLoads, nonprobeLoads: assignment.nonprobeLoads,
      nonprobes: assignment.nonprobes
    };
    const z = createNoiseMatrix(data, rng);
    const evaluated = evaluateScenario(c, data, z);
    const metrics = scoreMetrics(c, data, evaluated.scores);
    return { config: c, data, z, ...evaluated, metrics, createdAt: new Date().toISOString() };
  }

  function markResultsStale() {
    if (!lastResult) return;
    $('noticeBar').className = 'notice-bar';
    $('noticeBar').innerHTML = '<span class="notice-icon">!</span><span>Inputs changed since the last run. Results show the previous run until you click “Run experiment”.</span>';
    $('runStatus').textContent = 'Inputs changed · rerun to refresh results';
  }
  function runExperiment() {
    try {
      const c = readConfig();
      const errors = validateConfig(c, people);
      if (errors.length) throw new Error(errors[0]);
      const result = constructExperiment(c, people);
      lastResult = result; lastIncentiveResult = null; showAllReports = false;
      renderAllResults(); updateConstraints();
      $('noticeBar').className = 'notice-bar success';
      $('noticeBar').innerHTML = `<span class="notice-icon">✓</span><span>Experiment completed with seed ${c.seed}. ${c.n} students, ${c.probes} probe papers, K=${c.K}. All assignment checks passed.</span>`;
      $('runStatus').textContent = `Last run complete · seed ${c.seed} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      $('footerSeed').textContent = `Seed ${c.seed}`;
      toast('Experiment complete. Scoring rules, estimates and assignment have been updated.', 'success');
      return true;
    } catch (err) {
      updateConstraints(); $('noticeBar').className = 'notice-bar error'; $('noticeBar').innerHTML = `<span class="notice-icon">!</span><span>${safe(err.message || String(err))}</span>`;
      $('runStatus').textContent = 'Run blocked · check the setup and people table';
      toast(err.message || String(err), 'error'); return false;
    }
  }

  function renderMetrics(r) {
    const peqa = r.metrics.PEQA.rmse;
    const baseline = METHOD_ORDER.filter(m => m !== 'PEQA').map(m => ({ name: m, value: r.metrics[m].rmse })).sort((a, b) => a.value - b.value)[0];
    $('metricPeqa').textContent = fmt(peqa, 3);
    $('metricBaseline').textContent = fmt(baseline.value, 3);
    $('baselineName').textContent = `${baseline.name} RMSE · best baseline`;
    const pct = baseline.value > 0 ? (baseline.value - peqa) / baseline.value * 100 : 0;
    $('peqaDelta').textContent = peqa <= baseline.value ? `${fmt(Math.abs(pct), 1)}% lower than best baseline` : `${fmt(Math.abs(pct), 1)}% higher than best baseline`;
    $('peqaDelta').style.color = peqa <= baseline.value ? '#158872' : '#bd6b52';
    $('baselineDelta').textContent = `MAE ${fmt(r.metrics[baseline.name].mae, 3)}`;
    const mae = r.estimates.reduce((s, e, i) => s + Math.abs(e.bHat - r.data.people[i].bias), 0) / r.estimates.length;
    $('metricBias').textContent = fmt(mae, 3); $('biasFoot').textContent = `${r.estimates.length} graders estimated from probes`;
    $('metricCoverage').textContent = `${r.config.probes} / ${r.config.n}`;
    $('coverageFoot').textContent = `${fmt(r.config.probes / r.config.n * 100, 1)}% of papers instructor-verified`;
    $('estimateBiasMae').textContent = fmt(mae, 3);
    const ratios = r.estimates.map((e, i) => e.tauHat / r.data.people[i].tau).filter(v => Number.isFinite(v) && v > 0);
    $('estimateTauRatio').textContent = ratios.length ? `${fmt(median(ratios), 2)}×` : '—';
    $('estimateProbeReports').textContent = `${r.config.K / 2}`;
  }
  function renderRmseChart(r) {
    const pairs = METHOD_ORDER.map(m => ({ name: m, value: r.metrics[m].rmse })).sort((a, b) => a.value - b.value);
    const maxValue = Math.max(...pairs.map(p => p.value), 0.0001);
    $('rmseChart').className = 'chart-area';
    $('rmseChart').innerHTML = `<div class="bar-chart" role="img" aria-label="RMSE comparison across scoring methods">${pairs.map(p => `<div class="bar-row"><span class="bar-label">${p.name}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, p.value / maxValue * 100)}%;background:${METHOD_COLORS[p.name]}"></div></div><span class="bar-value">${fmt(p.value, 3)}</span></div>`).join('')}</div>`;
    $('rmseLegend').innerHTML = METHOD_ORDER.map(m => `<span class="legend-item"><i class="legend-swatch" style="background:${METHOD_COLORS[m]}"></i>${m} · MAE ${fmt(r.metrics[m].mae, 2)}</span>`).join('');
  }
  function renderHealth(r) {
    const checks = [
      ['Assignment constraints', 'All graders have K assignments; no self-grading; non-probe coverage satisfies q/q+1.', Object.values(r.data.assignmentChecks).every(Boolean)],
      ['Probe estimation', 'Every grader has K/2 probe reports for bias and reliability estimation.', r.estimates.every(e => e.probeCount === r.config.K / 2 && Number.isFinite(e.bHat) && Number.isFinite(e.tauHat))],
      ['Regrading assumption', 'Student final score is max(assigned score, true score) for this simulation.', true],
      ['Competitive-weight bound', `Theorem 1 condition w(n−1) ≤ 1 is ${r.config.competitiveWeight * (r.config.n - 1) <= 1 ? 'satisfied' : 'not satisfied'} for the uniform-weight setting.`, r.config.competitiveWeight * (r.config.n - 1) <= 1],
      ['Reproducibility', 'Pseudo-random generation is seeded; the same inputs and seed reproduce the run.', true]
    ];
    $('healthList').innerHTML = checks.map(([title, desc, pass]) => `<div class="health-item ${pass ? 'pass' : ''}"><span class="health-symbol">${pass ? '✓' : '!'}</span><div><strong>${title}</strong><small>${desc}</small></div><span class="health-value">${pass ? 'Passed' : 'Review'}</span></div>`).join('');
  }
  function renderReports(r) {
    const rows = Array.from({ length: r.config.n }, (_, p) => ({ p, isProbe: r.data.probeSet.has(p) }));
    const visible = showAllReports ? rows : rows.slice(0, Math.min(10, rows.length));
    reportBody.innerHTML = visible.map(({ p, isProbe }) => {
      const gs = r.data.gradersByPaper[p].map(g => `ST-${String(g + 1).padStart(3, '0')}`).join(', ');
      return `<tr><td class="number-cell">P-${String(p + 1).padStart(3, '0')}</td><td><span class="type-tag ${isProbe ? 'probe' : 'nonprobe'}">${isProbe ? 'Probe' : 'Non-probe'}</span></td><td title="${safe(gs)}">${r.data.gradersByPaper[p].length}</td><td class="number-cell">${fmt(r.data.people[p].trueScore, 2)}</td><td class="number-cell">${fmt(r.scores.PEQA[p], 2)}</td><td class="number-cell">${fmt(r.scores.Median[p], 2)}</td><td class="number-cell">${fmt(r.scores.Mean[p], 2)}</td><td class="number-cell">${fmt(r.scores.ERM[p], 2)}</td></tr>`;
    }).join('');
    $('goReports').textContent = showAllReports ? 'Show preview ↗' : `View all ${r.config.n} ↗`;
  }
  function renderAssignment(r) {
    const n = r.config.n;
    const probeSet = r.data.probeSet;
    const heads = Array.from({ length: n }, (_, p) => `<th class="${probeSet.has(p) ? 'probe-head' : ''}" title="Paper ${p + 1}${probeSet.has(p) ? ' · probe' : ''}">${p + 1}</th>`).join('');
    const body = r.data.assignmentsByGrader.map((papers, g) => {
      const set = new Set(papers);
      return `<tr><td>ST-${String(g + 1).padStart(3, '0')}</td>${Array.from({ length: n }, (_, p) => {
        const cls = p === g ? 'self' : set.has(p) ? (probeSet.has(p) ? 'probe-assigned' : 'assigned') : 'unassigned';
        const symbol = p === g ? '×' : set.has(p) ? '●' : '';
        return `<td class="${cls}" title="Grader ${g + 1} → paper ${p + 1}${p === g ? ' (self-grading forbidden)' : set.has(p) ? (probeSet.has(p) ? ' (probe assigned)' : ' (non-probe assigned)') : ''}">${symbol}</td>`;
      }).join('')}</tr>`;
    }).join('');
    $('assignmentMatrix').innerHTML = `<table class="assignment-table"><thead><tr><th>Grader ↓ · Paper →</th>${heads}</tr></thead><tbody>${body}</tbody></table>`;
    const nonLoads = r.data.nonprobes.map(p => r.data.gradersByPaper[p].length);
    $('assignmentSummary').textContent = `${n * r.config.K} assignments`;
    $('assignmentStats').innerHTML = [
      [`${r.config.K} / grader`, 'Fixed number of assigned papers'],
      [`${Math.min(...nonLoads)}–${Math.max(...nonLoads)}`, 'Graders per non-probe paper'],
      [`${r.data.probeLoads.reduce((a, b) => a + b, 0)}`, 'Total probe evaluations']
    ].map(([v, label]) => `<div class="assignment-stat"><strong>${v}</strong><span>${label}</span></div>`).join('');
  }
  function renderEstimates(r) {
    const records = r.estimates.map((e, i) => ({ e, p: r.data.people[i], err: e.bHat - r.data.people[i].bias })).sort((a, b) => estimateSortDescending ? Math.abs(b.err) - Math.abs(a.err) : a.p.id - b.p.id);
    estimateBody.innerHTML = records.map(({ e, p, err }) => `<tr><td class="number-cell">ST-${String(p.id).padStart(3, '0')}</td><td class="number-cell">${fmt(p.bias, 3)}</td><td class="number-cell">${fmt(e.bHat, 3)}</td><td class="number-cell ${Math.abs(err) < .0005 ? 'positive' : ''}">${fmtSigned(err, 3)}</td><td class="number-cell">${fmt(p.tau, 3)}</td><td class="number-cell">${fmt(e.tauHat, 3)}</td><td class="number-cell">${fmt(1 / Math.sqrt(e.tauHat), 3)}</td><td>${e.probeCount}</td></tr>`).join('');
    $('sortEstimateButton').textContent = estimateSortDescending ? 'Sort by ID ↑' : 'Sort by bias error ↓';
    renderBiasScatter(r);
    const medianRatio = median(r.estimates.map((e, i) => e.tauHat / r.data.people[i].tau));
    const scoreVals = r.estimates.flatMap((e, i) => [r.data.people[i].bias, e.bHat]);
    $('estimateTauRatio').title = `Median τ-hat / true τ: ${medianRatio}`;
  }
  function renderBiasScatter(r) {
    const w = 640, h = 270, pad = { l: 48, r: 18, t: 14, b: 38 };
    const all = r.data.people.flatMap((p, i) => [p.bias, r.estimates[i].bHat]);
    let low = Math.min(-1, ...all), high = Math.max(1, ...all);
    const span = high - low || 1; low -= span * .08; high += span * .08;
    const x = v => pad.l + (v - low) / (high - low) * (w - pad.l - pad.r);
    const y = v => h - pad.b - (v - low) / (high - low) * (h - pad.t - pad.b);
    const ticks = Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4);
    let svg = `<svg class="scatter-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Configured bias compared with estimated bias scatter plot">`;
    ticks.forEach(t => { svg += `<line x1="${pad.l}" y1="${y(t)}" x2="${w - pad.r}" y2="${y(t)}" stroke="#edf1f6"/><line x1="${x(t)}" y1="${pad.t}" x2="${x(t)}" y2="${h - pad.b}" stroke="#f1f4f7"/><text x="${x(t)}" y="${h - pad.b + 17}" text-anchor="middle" fill="#93a0b0" font-size="9">${fmt(t, 1)}</text><text x="${pad.l - 8}" y="${y(t) + 3}" text-anchor="end" fill="#93a0b0" font-size="9">${fmt(t, 1)}</text>`; });
    svg += `<line x1="${x(low)}" y1="${y(low)}" x2="${x(high)}" y2="${y(high)}" stroke="#a5b4c6" stroke-dasharray="5 4" stroke-width="1.5"/>`;
    r.data.people.forEach((p, i) => { svg += `<circle cx="${x(p.bias)}" cy="${y(r.estimates[i].bHat)}" r="4" fill="#178f80" fill-opacity=".72" stroke="#fff" stroke-width="1"><title>Grader ${i + 1}: true bias ${fmt(p.bias, 2)}, estimated ${fmt(r.estimates[i].bHat, 2)}</title></circle>`; });
    svg += `<text x="${(pad.l + w - pad.r) / 2}" y="${h - 6}" text-anchor="middle" fill="#718096" font-size="10">Configured bias bᵢ</text><text x="13" y="${h / 2}" text-anchor="middle" transform="rotate(-90 13 ${h / 2})" fill="#718096" font-size="10">Estimated bias b̂ᵢ</text></svg>`;
    $('biasChart').innerHTML = svg;
  }
  function updateIncentiveGraderOptions(r) {
    const old = $('incentiveGrader').value;
    $('incentiveGrader').innerHTML = r.data.people.map((p, i) => `<option value="${i}">ST-${String(p.id).padStart(3, '0')}</option>`).join('');
    $('incentiveGrader').value = Array.from($('incentiveGrader').options).some(o => o.value === old) ? old : '0';
  }
  function renderAllResults() {
    const r = lastResult;
    if (!r) return;
    renderMetrics(r); renderRmseChart(r); renderHealth(r); renderReports(r); renderAssignment(r); renderEstimates(r); updateIncentiveGraderOptions(r);
  }

  function renderIncentiveCurve(curve, graderIndex, reps, r) {
    const w = 760, h = 305, pad = { l: 61, r: 25, t: 22, b: 49 };
    const xs = curve.map(d => d.tau), ys = curve.map(d => d.utility);
    let xmin = Math.min(...xs), xmax = Math.max(...xs); if (xmin === xmax) { xmin *= .9; xmax *= 1.1; }
    let ymin = Math.min(...ys), ymax = Math.max(...ys); if (Math.abs(ymax - ymin) < 1e-8) { ymin -= 1; ymax += 1; } else { const sp = ymax - ymin; ymin -= sp * .1; ymax += sp * .1; }
    const x = v => pad.l + (v - xmin) / (xmax - xmin) * (w - pad.l - pad.r);
    const y = v => h - pad.b - (v - ymin) / (ymax - ymin) * (h - pad.t - pad.b);
    const ticksY = Array.from({ length: 5 }, (_, i) => ymin + (ymax - ymin) * i / 4);
    const ticksX = [xmin, xmin + (xmax - xmin) / 2, xmax];
    let svg = `<svg class="line-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Estimated expected utility by candidate reliability">`;
    ticksY.forEach(t => { svg += `<line x1="${pad.l}" y1="${y(t)}" x2="${w - pad.r}" y2="${y(t)}" stroke="#edf1f6"/><text x="${pad.l - 9}" y="${y(t) + 3}" text-anchor="end" fill="#8b98a9" font-size="9">${fmt(t, 2)}</text>`; });
    ticksX.forEach(t => { svg += `<line x1="${x(t)}" y1="${pad.t}" x2="${x(t)}" y2="${h - pad.b}" stroke="#f0f3f7"/><text x="${x(t)}" y="${h - pad.b + 18}" text-anchor="middle" fill="#8b98a9" font-size="9">${fmt(t, 3)}</text>`; });
    const points = curve.map(d => `${x(d.tau)},${y(d.utility)}`).join(' ');
    svg += `<polyline points="${points}" fill="none" stroke="#118f80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    curve.forEach(d => { svg += `<circle cx="${x(d.tau)}" cy="${y(d.utility)}" r="3.5" fill="#fff" stroke="#118f80" stroke-width="2"><title>τ=${fmt(d.tau, 3)}, estimated utility=${fmt(d.utility, 4)}</title></circle>`; });
    svg += `<text x="${(pad.l + w - pad.r) / 2}" y="${h - 9}" text-anchor="middle" fill="#718096" font-size="10">Candidate grading reliability τ (higher = lower noise)</text><text x="16" y="${h / 2}" text-anchor="middle" transform="rotate(-90 16 ${h / 2})" fill="#718096" font-size="10">Estimated expected utility</text></svg>`;
    $('incentiveChart').innerHTML = svg;
    const best = [...curve].sort((a, b) => b.utility - a.utility)[0];
    const monotonePairs = curve.slice(1).filter((d, i) => d.utility >= curve[i].utility - 1e-6).length;
    const trend = curve[curve.length - 1].utility - curve[0].utility;
    $('incentiveStatus').textContent = `${reps} repetitions`;
    $('incentiveSummary').innerHTML = `<strong>Selected grader:</strong> ST-${String(graderIndex + 1).padStart(3, '0')} · <strong>Highest sampled utility:</strong> ${fmt(best.utility, 4)} at τ=${fmt(best.tau, 3)}. <strong>Endpoint change:</strong> ${fmtSigned(trend, 4)} from τ=${fmt(curve[0].tau, 3)} to ${fmt(curve[curve.length - 1].tau, 3)}. <strong>Adjacent steps increasing:</strong> ${monotonePairs}/${curve.length - 1}. Values are Monte Carlo averages; small reversals may reflect finite-sample noise.`;
  }
  function runIncentiveSweep() {
    if (!lastResult) { toast('Run the base experiment first.', 'error'); return; }
    const r = lastResult, c = r.config, graderIndex = clamp(parseInt($('incentiveGrader').value, 10) || 0, 0, c.n - 1), reps = parseInt($('incentiveReps').value, 10) || 25;
    $('runIncentiveButton').disabled = true; $('runIncentiveButton').textContent = 'Calculating…';
    // Synchronous computation; at n<=150 and modest repeats this remains fully client-side.
    try {
      const count = 13;
      const low = c.tauMin, high = c.tauMax;
      const candidates = low === high ? [low] : Array.from({ length: count }, (_, i) => Math.exp(Math.log(low) + (Math.log(high) - Math.log(low)) * i / (count - 1)));
      const utilitySums = Array(candidates.length).fill(0);
      const rng = makeRng((c.seed ^ 0x51f15e) + 2309);
      for (let rep = 0; rep < reps; rep++) {
        const z = createNoiseMatrix(r.data, rng);
        candidates.forEach((tau, j) => {
          const ev = evaluateScenario(c, r.data, z, graderIndex, tau);
          utilitySums[j] += ev.utilities[graderIndex];
        });
      }
      const curve = candidates.map((tau, j) => ({ tau, utility: utilitySums[j] / reps }));
      lastIncentiveResult = { curve, graderIndex, reps };
      renderIncentiveCurve(curve, graderIndex, reps, r);
      toast('Reliability incentive curve calculated.', 'success');
    } catch (err) {
      toast(`Could not calculate the incentive curve: ${err.message || err}`, 'error');
    } finally {
      $('runIncentiveButton').disabled = false; $('runIncentiveButton').textContent = 'Recalculate utility curve';
    }
  }

  function downloadFile(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportConfig() {
    const payload = { schema: 'peqa-lab-scenario', version: 1, config: readConfig(), people: people.map(p => ({ ...p })), note: 'Blank true score, bias and reliability values are randomized at run time. Probe status: auto/probe/nonprobe.' };
    downloadFile(`peqa-scenario-seed-${payload.config.seed}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    toast('Scenario configuration exported as JSON.', 'success');
  }
  function exportResultsCsv() {
    if (!lastResult) { toast('Run the experiment before exporting results.', 'error'); return; }
    const r = lastResult;
    const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['paper_id', 'paper_type', 'grader_ids', 'grader_count', 'true_score', 'PEQA_assigned', 'PEQA_after_regrade', 'Median_assigned', 'Mean_assigned', 'ERM_assigned', 'PEQA_error', 'Median_error', 'Mean_error', 'ERM_error'];
    const lines = [header.join(',')];
    for (let p = 0; p < r.config.n; p++) {
      const gs = r.data.gradersByPaper[p].map(g => `ST-${String(g + 1).padStart(3, '0')}`).join(';');
      const truth = r.data.people[p].trueScore;
      const values = [`P-${String(p + 1).padStart(3, '0')}`, r.data.probeSet.has(p) ? 'probe' : 'nonprobe', gs, r.data.gradersByPaper[p].length, truth, r.scores.PEQA[p], r.finalScores[p], r.scores.Median[p], r.scores.Mean[p], r.scores.ERM[p], r.scores.PEQA[p] - truth, r.scores.Median[p] - truth, r.scores.Mean[p] - truth, r.scores.ERM[p] - truth];
      lines.push(values.map(esc).join(','));
    }
    downloadFile(`peqa-score-report-seed-${r.config.seed}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('Paper-level score report exported as CSV.', 'success');
  }
  function exportPeopleTemplate() {
    const lines = ['id,true_score,probe_status,bias,reliability', ...people.map(p => [p.id, p.score, p.probe, p.bias, p.tau].map(v => String(v ?? '')).join(','))];
    downloadFile('peqa-people-template.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('People CSV template exported.', 'success');
  }
  function csvParse(text) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
      else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim() !== ''));
  }
  function importCsvText(text) {
    const parsed = csvParse(text);
    if (parsed.length < 2) throw new Error('CSV needs a header row and at least one person row.');
    const headers = parsed[0].map(h => h.trim().toLowerCase());
    const find = (...names) => names.map(n => headers.indexOf(n)).find(i => i >= 0);
    const scoreI = find('true_score', 'score', 'true score'), probeI = find('probe_status', 'probe', 'probe status'), biasI = find('bias', 'b'), tauI = find('reliability', 'tau', 'τ');
    if (scoreI === undefined && probeI === undefined && biasI === undefined && tauI === undefined) throw new Error('CSV headers need one of true_score, probe_status, bias or reliability.');
    const imported = parsed.slice(1).map((r, i) => {
      let probe = (probeI === undefined ? 'auto' : String(r[probeI] ?? 'auto').trim().toLowerCase());
      if (['p', 'yes', 'true', '1'].includes(probe)) probe = 'probe';
      else if (['np', 'no', 'false', '0', 'non-probe', 'non_probe'].includes(probe)) probe = 'nonprobe';
      else if (!['probe', 'nonprobe', 'auto', ''].includes(probe)) throw new Error(`CSV row ${i + 2}: probe_status must be auto, probe or nonprobe.`);
      if (!probe) probe = 'auto';
      const get = idx => idx === undefined ? '' : String(r[idx] ?? '').trim();
      return { id: i + 1, score: get(scoreI), probe, bias: get(biasI), tau: get(tauI) };
    });
    if (imported.length < 6 || imported.length > 150) throw new Error('CSV must contain between 6 and 150 people.');
    $('nStudents').value = imported.length; resizePeople(imported.length); people = imported; renderPeopleTable(); updateConstraints(); markResultsStale();
    toast(`Imported ${people.length} people from CSV. Review K, probe count and constraints before running.`, 'success');
  }
  function importScenarioObject(obj) {
    if (!obj || typeof obj !== 'object' || !obj.config || !Array.isArray(obj.people)) throw new Error('This does not look like a PEQA Lab scenario JSON.');
    if (obj.schema && obj.schema !== 'peqa-lab-scenario') throw new Error('Unsupported scenario schema.');
    const c = { ...DEFAULTS, ...obj.config };
    if (!Number.isInteger(c.n) || c.n < 6 || c.n > 150 || obj.people.length !== c.n) throw new Error('Scenario must contain a matching population from 6 to 150 people.');
    applyConfig(c);
    people = obj.people.map((p, i) => ({ id: i + 1, score: p.score ?? p.trueScoreInput ?? '', probe: ['probe', 'nonprobe'].includes(p.probe) ? p.probe : ['probe', 'nonprobe'].includes(p.probeOverride) ? p.probeOverride : 'auto', bias: p.bias ?? '', tau: p.tau ?? p.reliability ?? '' }));
    renderPeopleTable(); updateConstraints(); markResultsStale();
    toast('Scenario imported. Run it to generate results with its current seed.', 'success');
  }
  function loadHybridDemo(autoRun = true) {
    applyConfig(DEFAULTS);
    people = Array.from({ length: DEFAULTS.n }, (_, i) => blankPerson(i + 1));
    const presets = {
      1: { score: '88', probe: 'probe', bias: '3.5', tau: '1.2' },
      2: { score: '74', probe: 'auto', bias: '-4.0', tau: '0.55' },
      3: { score: '62', probe: 'nonprobe', bias: '5.5', tau: '0.28' },
      4: { score: '91', probe: 'auto', bias: '', tau: '1.4' },
      5: { score: '56', probe: 'probe', bias: '-2.5', tau: '' },
      6: { score: '', probe: 'auto', bias: '0', tau: '0.12' },
      7: { score: '83', probe: 'auto', bias: '', tau: '0.9' },
      8: { score: '68', probe: 'auto', bias: '7', tau: '' },
      9: { score: '', probe: 'auto', bias: '-6', tau: '0.4' },
      10: { score: '77', probe: 'auto', bias: '', tau: '' }
    };
    Object.entries(presets).forEach(([id, vals]) => { Object.assign(people[Number(id) - 1], vals); });
    renderPeopleTable(); updateConstraints();
    if (autoRun) runExperiment(); else toast('Hybrid demo loaded.');
  }
  function clearAllRowOverrides() {
    people = people.map(p => blankPerson(p.id)); renderPeopleTable(); updateConstraints();
    $('randomSeed').value = int('randomSeed') + 1;
    runExperiment();
  }
  function resetToDefaults() {
    applyConfig(DEFAULTS); people = Array.from({ length: DEFAULTS.n }, (_, i) => blankPerson(i + 1)); renderPeopleTable(); loadHybridDemo(true);
  }
  function setActiveTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => { const active = t.dataset.tab === tabName; t.classList.toggle('active', active); t.setAttribute('aria-selected', active ? 'true' : 'false'); });
    document.querySelectorAll('.tab-panel').forEach(p => { const active = p.id === `panel-${tabName}`; p.classList.toggle('active', active); p.hidden = !active; });
    if (tabName === 'incentives' && lastResult && !lastIncentiveResult) $('incentiveGrader').value = '0';
  }
  function toast(message, kind = '') {
    const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = message; $('toastRegion').appendChild(el);
    window.setTimeout(() => el.remove(), 4200);
  }

  // Input / state bindings
  peopleBody.addEventListener('input', event => {
    const t = event.target; if (!t.dataset.field) return;
    const i = Number(t.dataset.index), f = t.dataset.field;
    if (!people[i]) return; people[i][f] = t.value;
    if (f !== 'probe') t.classList.toggle('auto-cell', !String(t.value).trim());
    if (f === 'tau') { const next = t.closest('tr').querySelector('td:last-child'); next.textContent = t.value && Number(t.value) > 0 ? fmt(1 / Math.sqrt(Number(t.value)), 3) : 'Auto'; }
    updateConstraints(); markResultsStale();
  });
  peopleBody.addEventListener('change', event => {
    const t = event.target; if (!t.dataset.field) return;
    const i = Number(t.dataset.index), f = t.dataset.field;
    if (people[i]) people[i][f] = t.value;
    updateConstraints(); markResultsStale();
  });
  ['nStudents', 'papersPerGrader'].forEach(id => $(id).addEventListener('change', () => {
    const n = clamp(parseInt($('nStudents').value, 10) || DEFAULTS.n, 6, 150); $('nStudents').value = n;
    resizePeople(n); renderPeopleTable(); updateConstraints(); markResultsStale();
  }));
  ['probeCount', 'priorMean', 'priorPrecision', 'scoreMin', 'scoreMax', 'scoreDistribution', 'biasMax', 'biasDistribution', 'reliabilityMin', 'reliabilityMax', 'alpha', 'competitiveWeight', 'randomSeed', 'clampReports'].forEach(id => {
    $(id).addEventListener('input', () => { updateConstraints(); markResultsStale(); if (id === 'scoreMin' || id === 'scoreMax') renderPeopleTable(); });
    $(id).addEventListener('change', () => { updateConstraints(); markResultsStale(); });
  });
  $('runButton').addEventListener('click', runExperiment); $('runTop').addEventListener('click', runExperiment);
  $('demoButton').addEventListener('click', () => loadHybridDemo(true));
  $('resetButton').addEventListener('click', resetToDefaults);
  $('clearInputsButton').addEventListener('click', clearAllRowOverrides);
  $('randomizeRows').addEventListener('click', () => { $('randomSeed').value = int('randomSeed') + 1; runExperiment(); });
  $('exportConfigTop').addEventListener('click', exportConfig); $('exportConfigButton').addEventListener('click', exportConfig);
  $('exportCsvButton').addEventListener('click', exportResultsCsv); $('downloadTemplate').addEventListener('click', exportPeopleTemplate);
  $('importConfigButton').addEventListener('click', () => $('importConfigFile').click());
  $('importConfigFile').addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try { importScenarioObject(JSON.parse(await file.text())); } catch (err) { toast(err.message || String(err), 'error'); }
    e.target.value = '';
  });
  $('importCsvButton').addEventListener('click', () => $('csvUpload').click());
  $('csvUpload').addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try { importCsvText(await file.text()); } catch (err) { toast(err.message || String(err), 'error'); }
    e.target.value = '';
  });
  $('goReports').addEventListener('click', () => { if (!lastResult) return; showAllReports = !showAllReports; renderReports(lastResult); $('panel-overview').querySelector('.table-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setActiveTab(t.dataset.tab)));
  $('sortEstimateButton').addEventListener('click', () => { estimateSortDescending = !estimateSortDescending; if (lastResult) renderEstimates(lastResult); });
  $('runIncentiveButton').addEventListener('click', runIncentiveSweep);
  $('incentiveGrader').addEventListener('change', () => { lastIncentiveResult = null; $('incentiveStatus').textContent = 'Needs recalculation'; });

  // Launch with a deterministic hybrid example so the dashboard is useful immediately.
  loadHybridDemo(true);
})();
