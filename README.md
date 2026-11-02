# @blockchainian/browser-test

A Playwright harness that runs each browser test as its own Node process. Tests in each mode share one Chromium that the project's fixtures prepare once, so independent processes run in parallel without repeating setup. The harness knows nothing about the project beyond the config it receives.

## Install

```sh
yarn add -D github:blockchainian/browser-test#<sha> playwright@1.64.1  # Playwright is a peer dependency
```

## Architecture

```mermaid
flowchart TD
    T["test processes"] -->|"startBrowserTest(options, config)"| BT["BrowserTest<br/>checks, screenshots, verdict"]
    BT --> BC["BrowserClient<br/>leases the browser, applies fixtures"]
    BC -->|"no browser running"| BH["BrowserHost<br/>detached process"]
    BH -->|"launches"| CH
    BC -->|"connectOverCDP"| CH["Chromium, one per mode<br/>default context: fixture state<br/>isolated context: no fixture state"]
    CH --> W["application at baseUrl"]
```

| Component       | Responsibility                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `BrowserTest`   | Owns the test's page, records checks, screenshots and console errors, and prints the verdict.                   |
| `BrowserClient` | Leases the browser, starts the host when none runs, applies fixtures and closes Chromium once no test needs it. |
| `BrowserHost`   | Keeps Chromium running after the test that started it, with a persistent profile and the config's `launchArgs`. |

## Config and fixtures

```ts
type Fixture = { name: string, isReady(context: BrowserContext): Promise<boolean>, apply(context: BrowserContext): Promise<void> }
type BrowserTestConfig = { baseUrl: string, fixtures?: Fixture[], launchArgs?: string[] } // launchArgs extend Chromium's flags
```

A fixture prepares the shared default context, for example by signing in, and opens and closes its own pages. A test names the fixtures it needs in `requires`, and naming an unknown fixture is an error. Each required fixture is applied only when `isReady` reports false, and the browser records it as applied. Because the persistent profile outlives the browser, a new browser first records every fixture the profile already satisfies.

A test whose `requires` covers every recorded fixture runs in the shared default context and shares its cookies and localStorage. Any other test runs in an isolated context with no fixture state.

## Interfaces

```js
// e2e/browserTest.mjs: the project's one wrapper, which its tests import
import { startBrowserTest as start } from '@blockchainian/browser-test'
const config = { baseUrl: 'http://localhost:3000', fixtures: [signedIn] }
export const startBrowserTest = (options) => start(options, config)
```

| Interface                                            | What it does                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `startBrowserTest({ test, requires = [] }, config)`  | Resolves with a `BrowserTest` owning a new page; `test` is the behavior text, reported even if startup fails.          |
| `test.page`, `test.baseUrl`                          | The test's Playwright `Page` and the config's base URL.                                                                |
| `test.check(assertion, result, evidence, { fatal })` | Records a check whose `result` is `'pass'`, `'fail'` or `'skip'`.                                                      |
| `test.screenshot(name)`                              | Saves a PNG named with letters, digits and hyphens under `output/`, records it and resolves with its path.             |
| `test.finish(test, { timing, verdict, errors })`     | Releases the page, prints the verdict and exits; `verdict` overrides the computed one and `errors` join `errors.test`. |

The verdict is the last line on stdout and takes one of three values:

- `pass` when no check failed, and `fail` otherwise.
- `inconclusive` on a startup or fixture failure, an uncaught exception, an interrupt, a missing `finish()`, or a failed page close or lease release, each listed in `errors.test`.
- `fail` whenever a check marked `fatal` failed, overriding any other verdict.

`errors.console` lists the page's console errors and never changes the verdict.

```json
{ "verdict": "pass", "test": "Open the page to see its heading.", "checks": [{ "assertion": "heading visible", "result": "pass", "evidence": "Welcome" }],
  "errors": { "console": [], "test": [] }, "screenshots": ["…/home-….png"], "timing": { "total_s": 2.29 } }
```

## Running

Run `node <test file>` inside the project's git repository, outside the Codex sandbox, while the application serves `baseUrl`. Tests run headless by default and `--headless=no` shows the browser, with no change to the test file. In headed mode, `BROWSER_DISPLAY` in `.browser-tests/.env` names the macOS display that opens the window.

Each mode keeps its own browser under `.browser-tests/headless/` or `.browser-tests/headed/`, so both modes run at once. Add `.browser-tests/` to `.gitignore`.

| Path                        | Contents                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `host.json`                 | CDP endpoint, host PID, active leases and applied fixtures.                             |
| `startup.lock/`, `waiters/` | The lock a test holds while leasing or releasing, and one file per test waiting for it. |
| `host.log`                  | Host output, lease and close events.                                                    |
| `profile/`                  | The persistent Chromium profile.                                                        |
| `output/`                   | Screenshots, one directory per test run.                                                |

## Writing a test

```js
#!/usr/bin/env node
import { startBrowserTest } from './browserTest.mjs'

const BEHAVIOR = 'Open the page to see its heading.'

// Start the test with the fixtures it needs
const test = await startBrowserTest({ test: BEHAVIOR, requires: ['signed-in'] })
const { page } = test

// Open the page
await page.goto(test.baseUrl)

try {
  // Check that the heading is visible
  const heading = page.getByRole('heading').first()
  await heading.waitFor({ timeout: 1_000 })
  test.check('heading visible', 'pass', await heading.textContent())
} catch (error) {
  test.check('heading visible', 'fail', error.message)
}

await test.screenshot('home')

await test.finish(BEHAVIOR)
```

Comment each step and separate steps with blank lines. Add no waits to make a test pass and no timeouts around the test; the harness owns them.

## Tests

`yarn test` checks that a test requiring a fixture sees its state, that a test requiring nothing does not, and that the latter still holds on a new browser whose profile kept the state.
