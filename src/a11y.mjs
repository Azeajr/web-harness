import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Accessibility scan with axe-core (an optional peer dependency the project installs). One
// classification for the controller (`check --a11y`), the Playwright helper (`checkA11y`) and the
// smoke's `a11y` phase: a violation at or above `impact` is an `a11y` fault; a lower one is a
// warning; a rule the project disables is still recorded, marked excused, so turning a rule off
// never makes its findings disappear. The proof boundary: automated rules find a subset of WCAG
// problems. A clean scan is not an accessibility audit, and every report says so.

export const IMPACTS = ["minor", "moderate", "serious", "critical"];
export const A11Y_BOUNDARY = "Automated rules find a subset of accessibility problems; a clean scan is not an audit.";

const list = (value, label) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new Error(`a11y.${label} must be an array of strings.`);
  return value;
};

// The adapter's `a11y` block, with per-run overrides (--a11y-impact, --a11y-disable).
export function a11yConfig(raw = {}, overrides = {}) {
  if (raw === false) raw = {};
  if (typeof raw !== "object" || raw === null) throw new Error("a11y must be an object.");
  const impact = overrides.impact ?? raw.impact ?? "serious";
  if (!IMPACTS.includes(impact)) throw new Error(`a11y.impact must be ${IMPACTS.join(", ")}.`);
  return {
    impact,
    disable: [...list(raw.disable, "disable"), ...list(overrides.disable, "disable")],
    include: list(raw.include, "include"),
    exclude: list(raw.exclude, "exclude"),
  };
}

// axe.min.js from the project's own dependencies, never a copy shipped here.
export async function axeSource(root) {
  let file;
  try {
    file = createRequire(path.join(root, "package.json")).resolve("axe-core/axe.min.js");
  } catch {
    throw new Error("The accessibility scan needs axe-core in the project: pnpm add -D axe-core");
  }
  return readFile(file, "utf8");
}

// A function whose body is axe itself, so page.evaluate ships it like any other function (no eval
// in the page, which a strict CSP forbids). The controller writes the same shape into run-code.
export const axeLoaderSource = (source) =>
  `function loadAxe() {\n${source}\n;return typeof window.axe === "object";\n}`;

// SERIALIZED. Run axe in the page (loading it once per document) and return bounded violations.
export async function runAxe(page, options, loadAxe) {
  if (!(await page.evaluate(() => typeof window.axe?.run === "function"))) await page.evaluate(loadAxe);
  return page.evaluate(async (settings) => {
    const context =
      settings.include.length || settings.exclude.length
        ? { include: settings.include.length ? settings.include.map((selector) => [selector]) : [["html"]], exclude: settings.exclude.map((selector) => [selector]) }
        : document;
    const result = await window.axe.run(context, { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({
      rule: violation.id,
      impact: violation.impact ?? "minor",
      help: violation.help,
      helpUrl: violation.helpUrl,
      count: violation.nodes.length,
      targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
    }));
  }, options);
}

// SERIALIZED. Violations → fault records (kind "a11y") and warnings.
export function classifyA11y(violations, settings) {
  const order = ["minor", "moderate", "serious", "critical"];
  const faults = [];
  const warnings = [];
  for (const violation of violations) {
    const record = {
      kind: "a11y",
      detail: `${violation.rule} (${violation.impact}): ${violation.help} — ${violation.count} × ${violation.targets.join(", ")} — ${violation.helpUrl}`,
      rule: violation.rule,
      impact: violation.impact,
      count: violation.count,
      targets: violation.targets,
      helpUrl: violation.helpUrl,
    };
    if (settings.disable.includes(violation.rule)) faults.push({ ...record, excusedBy: "a11y.disable" });
    else if (order.indexOf(violation.impact) >= order.indexOf(settings.impact)) faults.push(record);
    else warnings.push({ ...record, kind: "a11y-warning" });
  }
  return { faults, warnings };
}
