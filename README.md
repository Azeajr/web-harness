# web-harness

Shared development and verification harness for offline-first Vite PWAs on Cloudflare Pages:

- **Agent sessions** — an owned dev or production server and a bounded browser in the pinned
  Playwright Docker image; fixtures applied through the real UI; batched journeys returning compact
  JSON; `restart` on the same profile to prove durability.
- **One fault policy** for exploration and for the Playwright suite (`createHarnessTest`).
- **Production proof** — a Pages-style static server (`_headers` applied, SPA fallback) and a smoke
  that checks header values, bundle, service worker, persistence, offline and online reloads, and
  the update of an installed client to a new version.
- **Gates** — container E2E with canonical pixel baselines, mutation testing in a throwaway copy,
  an executable scenario inventory, and GitHub composite actions (`setup`, `scope`, `verdict`) for
  an always-reporting required check and deploys that ship the tested artifact.

Used by chess-mcp, chorequest, tabletop-strategy-companion and training-log. Read
[docs/HARNESS.md](docs/HARNESS.md) for the model, the adapter reference and the proof boundaries.

## Install

```sh
pnpm add -D github:Azeajr/web-harness#v0.1.4   # or: npm i -D github:Azeajr/web-harness#v0.1.4
```

Peer dependency: `playwright` (≥ 1.62; the Docker image is matched to your version). The Vite plugin
imports nothing from Vite and fits any major.

```ts
// vite.config.ts
import { webHarness } from '@azeajr/web-harness/vite'
plugins: [solid(), webHarness(), VitePWA({ ... })]

// playwright.config.ts
import { productionServer } from '@azeajr/web-harness/playwright'
webServer: productionServer({ port: 5175, build: 'pnpm build' })

// tests/e2e/fixtures.ts
import { test as base } from 'playwright/test'
import { createHarnessTest } from '@azeajr/web-harness/playwright'
import harness from '../../harness.config.mjs'
export const test = createHarnessTest(base, harness)
```

```yaml
# .github/workflows/ci.yml (excerpt)
- uses: Azeajr/web-harness/.github/actions/scope@v0.1.4
- uses: Azeajr/web-harness/.github/actions/setup@v0.1.4
  with: { node-version: 24, browsers: chromium }
- uses: Azeajr/web-harness/.github/actions/verdict@v0.1.4
  with: { needs: '${{ toJSON(needs) }}', code: '${{ needs.scope.outputs.code }}', required: checks e2e smoke }
```

## Commands

```
web-harness preflight | start | run FILE | observe SEL | state | effect … -- CLI | reload
            restart | reset | reconcile | screenshot LABEL | check | status | stop | cli ...
                                                                     (agent sessions)
web-harness serve --dir dist --port N [--unserved /api/]             (Pages-style server)
web-harness smoke [--dist DIR]                                       (production smoke)
web-harness e2e [--update-snapshots] [--prebuilt DIR] [--timezone Z --locale L] [pw args]
                                                                     (container E2E)
web-harness mutate [stryker args]                                    (mutation, throwaway copy)
web-harness scenarios [--results playwright.json] [--lane NAME=REPORT] [--allow-flaky]
                                                                     (scenario inventory)
web-harness digest DIR [--expect SHA]                                (build content digest)
```

## Development

```sh
pnpm install
pnpm check          # syntax + unit tests (one test drives a real Chromium)
```

```sh
pnpm test:acceptance   # real sessions, smoke and container E2E against examples/minimal
```

The acceptance suite packs this repository, installs it into a copy of `examples/minimal` and
drives it through the installed bin. It is heavy — one 3 GiB session container at a time, then a
container E2E run — so run it alone. It needs Docker, the Playwright image for this version
(`docker pull mcr.microsoft.com/playwright:v<version>-noble`) and a host Chromium.

## Releasing

Released by tag. Consumers pin a tag in both the dependency and the `uses:` references; bump them
together (`web-harness doctor` warns when a workflow's `uses:` differs from the installed version).

1. Merge to `main` with `verdict` green (it includes the acceptance suite).
2. Bump `version` in `package.json`, and every `#vX.Y.Z` / `@vX.Y.Z` in this README.
3. Tag `vX.Y.Z` on the merge commit and push the tag.
4. In each consumer: bump the dependency and every `uses: Azeajr/web-harness/...@vX.Y.Z` in one PR.

## License

MIT
