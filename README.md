# @blockchainian/browser-test

A Playwright harness for browser tests that run as independent Node processes against one shared Chromium. Each test process leases the browser, opens its own page, records checks, screenshots and console errors, and prints a single verdict JSON line. Several processes, such as parallel agents, share the same browser and profile without opening another window or repeating project setup. The harness knows nothing about any project: a project describes its base URL, setup steps and Chromium flags in a config.

## Install

The package is consumed as a git dependency pinned to a commit, with Playwright as a peer dependency.

```sh
yarn add -D github:blockchainian/browser-test#<sha> playwright@1.64.1
```

Chromium comes from Playwright's own cache (`~/Library/Caches/ms-playwright`), so every project on the same Playwright version shares one browser install. Each project keeps its own profile.

## Config and fixtures

A project describes itself with a `BrowserTestConfig`.

```ts
interface BrowserTestConfig {
  baseUrl: string
  fixtures?: Fixture[]
  launchArgs?: string[]
}

interface Fixture {
  name: string
  isReady(context: BrowserContext): Promise<boolean>
  apply(context: BrowserContext): Promise<void>
}
```

`baseUrl` is exposed to tests as `test.baseUrl`. `launchArgs` are appended to the arguments the host passes to Chromium. A fixture prepares the shared browser, for example by signing in: `isReady` inspects the shared default `BrowserContext` and `apply` brings it to the ready state. Both receive that context and open and close their own pages.

## Writing a test

A project wraps `startBrowserTest` once so that tests do not repeat the config.

```js
// e2e/browserTest.mjs
import { startBrowserTest as start } from '@blockchainian/browser-test'

const config = {
  baseUrl: 'http://localhost:3004',
  fixtures: [signedInFixture],
  launchArgs: [],
}

export const startBrowserTest = (options) => start(options, config)
```

```js
// e2e/watchlist.mjs
import { startBrowserTest } from './browserTest.mjs'

const BEHAVIOR = 'Open the Watchlist to see watched tokens.'

const test = await startBrowserTest({ test: BEHAVIOR, requires: ['signed-in'] })
await test.page.goto(test.baseUrl)
test.check('page loaded', 'pass', await test.page.title())
await test.screenshot('watchlist')
await test.finish(BEHAVIOR)
```

`startBrowserTest({ test, requires }, config)` resolves with a `BrowserTest` that owns a new page. `test.page` is the Playwright `Page`. `test.check(assertion, result, evidence, { fatal })` records a check whose result is `pass`, `fail` or `skip`; a failed fatal check fails the verdict whatever `finish()` is given. `test.screenshot(name)` saves a PNG and resolves with its path. `test.finish(test, { timing, verdict, errors })` releases the page, prints the verdict and exits the process.

The verdict is one JSON line on stdout:

```json
{
  "verdict": "pass",
  "test": "Open the Watchlist to see watched tokens.",
  "checks": [{ "assertion": "page loaded", "result": "pass", "evidence": "…" }],
  "errors": { "console": [], "test": [] },
  "screenshots": ["…/watchlist-….png"],
  "timing": { "total_s": 2.29 }
}
```

Console errors are recorded in `errors.console` and do not change the verdict. Startup failures, uncaught exceptions, interrupts, a missing `finish()` and page-close or lease-release errors are recorded in `errors.test` and make the verdict `inconclusive`. Tests must run outside the Codex sandbox, which cannot start Chromium.

Pass `--headless=no` to the test process to show the browser; `--headless=yes` is the default. In headed mode the window can be placed on a named display by setting `BROWSER_DISPLAY=<display name>` in `.browser-tests/.env`.

## Scheduling

The first test to find no running browser starts a detached host process, `node src/browserTest.mjs --host`, which launches Chromium with a persistent profile and a loopback debugging port. Later tests find that host through its state file and connect over CDP. The host receives the config's launch arguments in the `BROWSER_TEST_LAUNCH_ARGS` environment variable.

Under the startup lock, a test takes its lease and then looks up each fixture named in `requires`. It calls `isReady` on the shared default context and applies the fixture with `apply` when it is not ready. Every fixture applied on the shared browser is recorded in the host state, so each is applied once per browser. A test whose `requires` covers all recorded fixtures opens its page in the shared default context and sees their effects. A test that does not require a recorded fixture opens its page in a new isolated context with no shared state, and that context is closed with the test. A name in `requires` that the config does not define is an error.

When the host is launched, `isReady` runs for every configured fixture and the ones already ready are recorded, because fixture state kept in the persistent profile survives the host. A test that requires nothing therefore gets an isolated context on a fresh host too. The browser closes when the last lease and the last waiting test are gone.

## Runtime layout

The runtime directory is `.browser-tests/headless` or `.browser-tests/headed` at the root of the git repository the test runs in, so the two modes run side by side, each with its own browser and profile.

| Path            | Contents                                                                               |
| --------------- | -------------------------------------------------------------------------------------- |
| `host.json`     | Debugging endpoint, host process ID, active leases and applied fixture names.          |
| `startup.lock/` | Directory holding a file named after the owning process ID while leasing or releasing. |
| `waiters/`      | One file per test waiting for the lock, so the browser stays up while tests queue.     |
| `host.log`      | Host stdout and stderr plus lease and close events.                                    |
| `profile/`      | The persistent Chromium profile.                                                       |
| `output/`       | Screenshots, one directory per test run.                                               |

Locks, waiters and leases belong to their recorded process IDs. A process is alive when `process.kill(pid, 0)` succeeds or fails with `EPERM`; `ESRCH` makes its records stale. Clients reclaim stale startup locks while waiting, drop dead leases when reading host state and remove dead waiters before deciding whether the browser is idle. The startup lock is published by atomically renaming a directory that already contains its owner file, so a competing client can never remove a replacement lock.

Add `.browser-tests/` to the project's `.gitignore`.

## Tests

`yarn test` runs a smoke test that serves a local page and applies a fixture that sets a localStorage key. It checks that a test requiring the fixture sees the key, that a test requiring nothing gets an isolated context without it, and that the same holds on a new host whose profile still holds the key.
