// Pure layout/stat computation for the coverage-history chart, split out
// of index.html's inline script so it has real automated coverage
// (chart-math.test.mjs, run via `node --test` in ci.yml's test-ci-scripts
// job) instead of relying on by-hand verification. index.html imports this
// directly as an ES module — verified empirically that GitHub Pages serves
// .mjs as `text/javascript`, so `<script type="module" src="chart-math.mjs">`
// loads correctly there, not just under Node.
//
// No DOM/SVG-string building here on purpose: that stays in index.html so
// this file has zero browser-only globals and can run under plain Node.

export function computeChartLayout(rows, options = {}) {
  const width = options.width ?? 860;
  const height = options.height ?? 220;
  const padL = options.padL ?? 42;
  const padR = options.padR ?? 16;
  const padT = options.padT ?? 16;
  const padB = options.padB ?? 28;

  if (!rows || rows.length === 0) {
    return { empty: true };
  }

  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const pcts = rows.map((r) => r.pct);
  let yMin = Math.floor(Math.min(...pcts) - 2);
  let yMax = Math.ceil(Math.max(...pcts) + 2);
  if (yMax - yMin < 5) {
    yMin -= 2;
    yMax += 2;
  }
  yMin = Math.max(0, yMin);
  yMax = Math.min(100, yMax);

  const x = (i) => (rows.length === 1 ? padL + plotW / 2 : padL + (i / (rows.length - 1)) * plotW);
  const y = (pct) => padT + plotH - ((pct - yMin) / (yMax - yMin)) * plotH;

  const points = rows.map((r, i) => ({
    x: x(i),
    y: y(r.pct),
    pct: r.pct,
    date: r.date,
    commit: r.commit || "",
  }));

  const steps = 4;
  const gridLines = [];
  for (let s = 0; s <= steps; s++) {
    const value = yMin + (s / steps) * (yMax - yMin);
    gridLines.push({ value, y: y(value) });
  }

  return {
    empty: false,
    width,
    height,
    padL,
    padR,
    padT,
    padB,
    plotW,
    plotH,
    yMin,
    yMax,
    points,
    gridLines,
  };
}

export function computeStats(rows) {
  if (!rows || rows.length === 0) {
    return { empty: true };
  }
  const latest = rows[rows.length - 1];
  const first = rows[0];
  return {
    empty: false,
    latestPct: latest.pct,
    latestDate: latest.date,
    count: rows.length,
    deltaPp: Number((latest.pct - first.pct).toFixed(2)),
    hasDelta: rows.length > 1,
  };
}
