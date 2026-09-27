import { Script } from "node:vm";
import { checkExpectation, diffValues, readWatched, settle, stableObservation } from "./effect.mjs";
import { captureStorage, sliceRing } from "./evidence.mjs";
import { failures, unmetExpectations } from "./faults.mjs";
import { observe, readState } from "./inspect.mjs";

// Trusted local code, like --setup and cli run-code. No second action language or browser server.
// `stateSpec` is page-side source for the adapter's state accessor: an object expression with
// sections, defaults, target and read. `policy` is the fault policy as JSON. `durable` is the
// adapter's durable.read source (or "null"). `trace` is off, retain-on-failure or keep.
//
// The batch receives { step, assert, observe, state, effect, allowFault, expectFault }. On failure
// it keeps a bundle under `${artifactBase}/bundle/`: the screenshot here, and the rest (network,
// console, accessibility tree, storage, state) returned for the controller to write.
export function batchSource(
  source,
  artifactBase,
  { stateSpec = "{ sections: [], defaults: [] }", policy, durable = "null", trace = "off", batchId = "batch" } = {},
) {
  const expression = source.trim().replace(/;$/, "");
  new Script(`(${expression})`); // Reject malformed input before browser interactions.
  return `async page => {
    const observe = ${observe.toString()};
    const readState = ${readState.toString()};
    const failures = ${failures.toString()};
    const unmetExpectations = ${unmetExpectations.toString()};
    const sliceRing = ${sliceRing.toString()};
    const captureStorage = ${captureStorage.toString()};
    const stableObservation = ${stableObservation.toString()};
    const readWatched = ${readWatched.toString()};
    const diffValues = ${diffValues.toString()};
    const settle = ${settle.toString()};
    const checkExpectation = ${checkExpectation.toString()};
    const policy = ${JSON.stringify(policy ?? { allowed: [] })};
    const stateSpec = ${stateSpec};
    const durable = ${durable};
    const traceMode = ${JSON.stringify(trace)};
    const batchId = ${JSON.stringify(batchId)};
    const base = ${JSON.stringify(artifactBase)};
    const context = page.context();
    const evidence = context.__webHarnessEvidence ?? null;
    const records = () => context.__webHarnessFaults ?? [];
    // Marks: what existed before this batch is context, not the batch's own doing.
    const mark = evidence ? evidence.seq : 0;
    const faultMark = records().length;
    const started = Date.now();
    const steps = [];
    const effects = [];
    const artifacts = {};
    const artifactErrors = [];
    const bundle = {};
    const local = [];
    const expected = [];
    const toSource = (pattern) => (pattern instanceof RegExp ? pattern.source : String(pattern));
    const allowFault = (pattern) => { local.push(toSource(pattern)); };
    const expectFault = (kind, pattern) => {
      expected.push({ kind: kind ?? null, pattern: toSource(pattern) });
      local.push(toSource(pattern));
    };
    const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
    const step = async (name, action) => {
      const item = { name: String(name).slice(0, 120), ms: 0, ok: false, startedAt: new Date().toISOString(), endedAt: null };
      if (steps.length >= 100) throw new Error('A batch supports at most 100 named steps.');
      steps.push(item);
      const start = Date.now();
      try { const value = await action(); item.ok = true; return value; }
      finally { item.ms = Date.now() - start; item.endedAt = new Date().toISOString(); }
    };
    const watchLib = { observe, readState, stateSpec, durable, stableObservation };
    const effect = async (name, action, watch = {}) => {
      const effectMark = evidence ? evidence.seq : 0;
      const index = effects.length;
      const before = await readWatched(page, watch, watchLib);
      if (watch.screenshot) await page.screenshot({ path: base + '/effect-' + index + '-before.png', scale: 'css' });
      const value = await step(name, action);
      const settled = watch.settle ? (await watch.settle(page), true) : await settle(page, effectMark, 5000);
      const after = await readWatched(page, watch, watchLib);
      if (watch.screenshot) await page.screenshot({ path: base + '/effect-' + index + '-after.png', scale: 'css' });
      const diff = diffValues(before.values, after.values, { entries: 50, value: 200 });
      effects.push({
        name: String(name).slice(0, 120), settled, ...diff,
        unsupported: [...new Set([...before.unsupported, ...after.unsupported])],
        before: before.at, after: after.at,
      });
      const problem = checkExpectation(name, watch.expect, diff, before, after);
      if (problem) throw new Error(problem);
      return value;
    };
    let tracing = false;
    if (traceMode !== 'off') {
      try { await context.tracing.start({ screenshots: true, snapshots: true, title: batchId }); tracing = true; }
      catch (failure) { artifactErrors.push('trace: ' + String(failure.message).slice(0, 300)); }
    }
    let result = null, error = null, unmet = [];
    try {
      result = await (${expression})(page, {
        observe: (target, options) => observe(page, target, options),
        state: sections => readState(page, sections, stateSpec),
        step, assert, effect, allowFault, expectFault,
      }) ?? null;
      // Require serializable results while still inside the evidence-capture boundary.
      JSON.stringify(result);
      // Faults trail their cause: the browser's "Failed to load resource" line, a response body
      // that fails after its status. Let what the batch started finish before judging it.
      await settle(page, mark, 3000);
      // A batch excuses only faults from its own run; earlier ones are judged as they were.
      const all = records();
      const own = all.slice(faultMark);
      const counted = [...failures(all.slice(0, faultMark), policy), ...failures(own, policy, local)];
      for (const record of own)
        if (!record.excusedBy && !counted.includes(record) && local.some((pattern) => new RegExp(pattern).test(record.detail)))
          record.excusedBy = batchId;
      unmet = unmetExpectations(own, expected);
      if (unmet.length)
        throw new Error(unmet.map((item) => 'expected ' + (item.kind ?? 'fault') + ' matching /' + item.pattern + '/ never occurred').join('; '));
      if (counted.length) throw new Error(counted.length + ' retained browser fault(s): ' + counted.slice(-3).map(f => f.kind + ': ' + f.detail).join('; '));
    } catch (failure) {
      error = String(failure?.message ?? failure).slice(0, 2000);
      const capture = async (name, work) => {
        try { return await work(); }
        catch (failure) { artifactErrors.push(name + ': ' + String(failure?.message ?? failure).slice(0, 300)); return null; }
      };
      const shot = base + '/bundle/screenshot.png';
      if (await capture('screenshot', () => page.screenshot({ path: shot, timeout: 5000, scale: 'css' })) !== null)
        artifacts.screenshot = shot;
      artifacts.state = await capture('state', () => readState(page, undefined, stateSpec));
      bundle.aria = await capture('aria', () => page.locator('body').ariaSnapshot({ timeout: 5000 }));
      bundle.storage = await capture('storage', () => captureStorage(page));
      bundle.url = page.url();
      if (evidence) {
        bundle.network = sliceRing(evidence.requests, mark, 50);
        bundle.console = sliceRing(evidence.console, mark, 50);
      } else artifactErrors.push('evidence: no request/console rings on this context');
    }
    if (tracing) {
      try {
        if (error !== null) { await context.tracing.stop({ path: base + '/bundle/trace.zip' }); artifacts.trace = base + '/bundle/trace.zip'; }
        else if (traceMode === 'keep') { await context.tracing.stop({ path: base + '/trace.zip' }); artifacts.trace = base + '/trace.zip'; }
        else await context.tracing.stop();
      } catch (failure) { artifactErrors.push('trace: ' + String(failure.message).slice(0, 300)); }
    }
    // Judged again here: a batch that threw early never reached the check above.
    const own = records().slice(faultMark);
    const missing = unmetExpectations(own, expected);
    return { ok: error === null, result: error === null ? result : null, error, steps, effects,
      executionMs: Date.now() - started, artifacts, artifactErrors,
      expectedFaults: expected.map((item) => ({ ...item, met: !missing.includes(item),
        matched: own.filter((record) => (!item.kind || record.kind === item.kind) && new RegExp(item.pattern).test(record.detail)).length })),
      allowedFaults: local,
      bundle: error === null ? null : bundle,
      faults: records().slice(-20),
      faultCount: records().length };
  }`;
}
