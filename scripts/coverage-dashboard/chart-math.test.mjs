import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChartLayout, computeStats } from "./chart-math.mjs";

const approxEqual = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `expected ${a} ~= ${b}`);

const DEFAULT_PAD_T = 16;
const DEFAULT_HEIGHT = 220;
const DEFAULT_PAD_B = 28;
const DEFAULT_PAD_L = 42;
const DEFAULT_WIDTH = 860;
const DEFAULT_PAD_R = 16;

function assertInBounds(point) {
  assert.ok(point.x >= DEFAULT_PAD_L - 1e-6 && point.x <= DEFAULT_WIDTH - DEFAULT_PAD_R + 1e-6, `x ${point.x} out of plot bounds`);
  assert.ok(point.y >= DEFAULT_PAD_T - 1e-6 && point.y <= DEFAULT_HEIGHT - DEFAULT_PAD_B + 1e-6, `y ${point.y} out of plot bounds`);
}

test("computeChartLayout: empty rows returns {empty: true}", () => {
  assert.deepEqual(computeChartLayout([]), { empty: true });
  assert.deepEqual(computeChartLayout(null), { empty: true });
});

test("computeChartLayout: single point is horizontally centered and in-bounds", () => {
  const layout = computeChartLayout([{ date: "2026-08-16T00:00:00Z", commit: "abc", pct: 90 }]);
  assert.equal(layout.empty, false);
  assert.equal(layout.points.length, 1);
  approxEqual(layout.points[0].x, layout.padL + layout.plotW / 2);
  assertInBounds(layout.points[0]);
});

test("computeChartLayout: single point at 100% clamps to the top of the plot area, not off-chart", () => {
  const layout = computeChartLayout([{ date: "2026-08-16T00:00:00Z", commit: "abc", pct: 100 }]);
  approxEqual(layout.points[0].y, layout.padT);
  assertInBounds(layout.points[0]);
});

test("computeChartLayout: single point at 0% clamps to the bottom of the plot area, not off-chart", () => {
  const layout = computeChartLayout([{ date: "2026-08-16T00:00:00Z", commit: "abc", pct: 0 }]);
  approxEqual(layout.points[0].y, layout.height - layout.padB);
  assertInBounds(layout.points[0]);
});

test("computeChartLayout: multiple points are spaced left-to-right and ordered by pct on the y axis", () => {
  const rows = [
    { date: "2026-08-14T00:00:00Z", commit: "a", pct: 80 },
    { date: "2026-08-15T00:00:00Z", commit: "b", pct: 85 },
    { date: "2026-08-16T00:00:00Z", commit: "c", pct: 90 },
  ];
  const layout = computeChartLayout(rows);
  assert.equal(layout.points.length, 3);

  approxEqual(layout.points[0].x, layout.padL);
  approxEqual(layout.points[2].x, layout.width - layout.padR);
  assert.ok(layout.points[0].x < layout.points[1].x && layout.points[1].x < layout.points[2].x);

  // Higher coverage % must plot higher on screen, i.e. a smaller y.
  assert.ok(layout.points[0].y > layout.points[1].y && layout.points[1].y > layout.points[2].y);

  for (const p of layout.points) assertInBounds(p);
});

test("computeChartLayout: gridLines always has 5 evenly spaced steps between yMin and yMax", () => {
  const layout = computeChartLayout([
    { date: "2026-08-15T00:00:00Z", commit: "a", pct: 80 },
    { date: "2026-08-16T00:00:00Z", commit: "b", pct: 90 },
  ]);
  assert.equal(layout.gridLines.length, 5);
  approxEqual(layout.gridLines[0].value, layout.yMin);
  approxEqual(layout.gridLines[4].value, layout.yMax);
});

test("computeStats: empty rows returns {empty: true}", () => {
  assert.deepEqual(computeStats([]), { empty: true });
});

test("computeStats: single row has no delta", () => {
  const stats = computeStats([{ date: "2026-08-16T00:00:00Z", commit: "a", pct: 91.52 }]);
  assert.equal(stats.hasDelta, false);
  assert.equal(stats.latestPct, 91.52);
  assert.equal(stats.count, 1);
});

test("computeStats: multiple rows compute the delta between first and latest", () => {
  const stats = computeStats([
    { date: "2026-08-14T00:00:00Z", commit: "a", pct: 88 },
    { date: "2026-08-15T00:00:00Z", commit: "b", pct: 90 },
    { date: "2026-08-16T00:00:00Z", commit: "c", pct: 91.5 },
  ]);
  assert.equal(stats.hasDelta, true);
  assert.equal(stats.count, 3);
  assert.equal(stats.latestPct, 91.5);
  approxEqual(stats.deltaPp, 3.5);
});
