// ABOUTME: BrowserClient owns host leases and fixtures; BrowserHost runs shared Chromium.
// ABOUTME: BrowserTest owns test checks, screenshots and console errors, then emits one verdict JSON.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import { chromium } from 'playwright'

const OPERATION_TIMEOUT_MS = 30_000
const HOST_START_TIMEOUT_MS = 30_000
const HOST_CHECK_TIMEOUT_MS = 2_000
const LOCK_RETRY_MS = 100
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const LOOPBACK = '127.0.0.1'
const HOST_FLAG = '--host'
const HOST_LAUNCH_ARGS_ENV = 'BROWSER_TEST_LAUNCH_ARGS'
const HEADLESS = parseHeadless()
const BROWSER_TEST_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()
const RUNTIME_DIR = join(
  REPO_ROOT,
  '.browser-tests',
  HEADLESS ? 'headless' : 'headed',
)
const HOST_STATE_FILE = join(RUNTIME_DIR, 'host.json')
const STARTUP_LOCK_DIR = join(RUNTIME_DIR, 'startup.lock')
const WAITERS_DIR = join(RUNTIME_DIR, 'waiters')
const HOST_LOG_FILE = join(RUNTIME_DIR, 'host.log')
const DEV_INDICATOR_STYLE_HASH =
  "'sha256-EoMjSG2tAB665e0WcIEcGUS3EJ0s2W1aCtvErN/9hrE='"
function parseHeadless() {
  let headless = true
  for (const argument of process.argv.slice(2)) {
    if (argument !== '--headless' && !argument.startsWith('--headless=')) {
      continue
    }
    const value = argument.slice('--headless='.length)
    if (value !== 'yes' && value !== 'no') {
      throw new Error('--headless must be yes or no')
    }
    headless = value === 'yes'
  }
  return headless
}

/**
 * Records one test's exclusive Page and verdict, releasing its host lease on finish.
 * @param {{ client: BrowserClient, baseUrl: string, behavior?: string, startedAt?: number }} options
 * @returns {BrowserTest} A page-owning test with checks, screenshots and console error records.
 * @throws {Error} A screenshot fails, its name is invalid or a check result is invalid.
 */
export class BrowserTest {
  #client
  #behavior
  #startedAt
  #page
  #checks = []
  #screenshots = []
  #outputDir = join(RUNTIME_DIR, 'output', randomUUID())
  #consoleErrorLines = []
  #fatalCheckFailed = false
  #finished

  constructor({ client, baseUrl, behavior, startedAt = Date.now() }) {
    this.#client = client
    this.#behavior = behavior
    this.baseUrl = baseUrl
    this.#startedAt = startedAt
  }

  get page() {
    return this.#page
  }

  set page(page) {
    if (this.#page !== undefined) {
      throw new Error('test already owns a page')
    }
    this.#page = page
    page.on('console', (message) => this.#recordConsole(message))
  }

  async screenshot(name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      throw new Error(`invalid screenshot name: ${name}`)
    }
    await mkdir(this.#outputDir, { recursive: true, mode: PRIVATE_DIR_MODE })
    const path = join(this.#outputDir, `${name}-${randomUUID()}.png`)
    await this.#page.screenshot({ path, timeout: OPERATION_TIMEOUT_MS })
    this.#screenshots.push(path)
    return path
  }

  check(assertion, result, evidence, { fatal = false } = {}) {
    if (!['pass', 'fail', 'skip'].includes(result)) {
      throw new Error(`invalid check result: ${result}`)
    }
    this.#checks.push({ assertion, result, evidence })
    if (result === 'fail' && fatal) {
      this.#fatalCheckFailed = true
    }
  }

  finish(options = {}) {
    this.#finished ??= this.#teardown(options)
    return this.#finished
  }

  async #teardown({ timing = {}, verdict, errors = [] } = {}) {
    const releaseErrors = await this.#client.release(this.#page)
    if (releaseErrors.length > 0) {
      verdict = 'inconclusive'
    }
    const result = this.#buildVerdict(timing, verdict, [
      ...errors,
      ...releaseErrors,
    ])
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
  }

  #buildVerdict(timing, verdict, errors) {
    const elapsedMs = Date.now() - this.#startedAt
    const outcome = this.#checks.some((check) => check.result === 'fail')
      ? 'fail'
      : 'pass'
    return {
      verdict: this.#fatalCheckFailed ? 'fail' : verdict ?? outcome,
      test: this.#behavior,
      checks: this.#checks,
      errors: { console: this.#consoleErrorLines, test: errors },
      screenshots: this.#screenshots,
      timing: {
        ...timing,
        total: elapsedMs,
      },
    }
  }

  #recordConsole(message) {
    if (message.type() !== 'error') {
      return
    }
    this.#consoleErrorLines.push(
      ...message
        .text()
        .split('\n')
        .filter(
          (line) =>
            !(
              line.includes(
                'Applying inline style violates the following Content Security Policy directive',
              ) && line.includes(DEV_INDICATOR_STYLE_HASH)
            ),
        )
        .map((line) => `[error] ${line}`),
    )
  }
}

class BrowserClient {
  static parseHostState(value) {
    try {
      const url = new URL(value.endpoint)
      if (
        url.protocol !== 'http:' ||
        url.hostname !== LOOPBACK ||
        !url.port ||
        url.pathname !== '/' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !Number.isInteger(value.pid) ||
        value.pid <= 0
      ) {
        throw new Error('expected loopback endpoint and process id')
      }
      const { launchArgs = [], viewport = DEFAULT_VIEWPORT } = value
      return { endpoint: url.origin, pid: value.pid, launchArgs, viewport }
    } catch (error) {
      // Invalid host state is rejected without exposing its contents.
      throw new Error('invalid test host state', { cause: error })
    }
  }

  // Playwright's page/context creation, evaluation and close APIs have no timeout option.
  static async withTimeout(label, operation, timeoutMs = OPERATION_TIMEOUT_MS) {
    const signal = AbortSignal.timeout(timeoutMs)
    let onTimeout
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          onTimeout = () => {
            const error = new Error(`${label} exceeded ${timeoutMs}ms`, {
              cause: signal.reason,
            })
            error.name = 'TimeoutError'
            reject(error)
          }
          signal.addEventListener('abort', onTimeout, { once: true })
        }),
      ])
    } finally {
      signal.removeEventListener('abort', onTimeout)
    }
  }

  static #connect(endpoint) {
    return chromium.connectOverCDP(endpoint, { timeout: OPERATION_TIMEOUT_MS })
  }

  #config
  #requires = []
  #lease
  #browser
  #isolatedContext

  constructor(config) {
    this.#config = config
  }

  async acquire(requires = []) {
    this.#requires = this.#selectFixtures(requires)
    this.#lease = await this.#acquireLease()
    return this.#lease
  }

  #selectFixtures(names) {
    const fixtures = this.#config.fixtures ?? []
    return names.map((name) => {
      const fixture = fixtures.find((fixture) => fixture.name === name)
      if (fixture === undefined) {
        throw new Error(`unknown fixture: ${name}`)
      }
      return fixture
    })
  }

  async openPage(requires) {
    await this.acquire(requires)
    this.#browser = await BrowserClient.#connect(this.#lease.endpoint)
    // A fixture applied to the shared context but not required here would leak into this test.
    if (this.#lease.applied.some((name) => !requires.includes(name))) {
      this.#isolatedContext = await BrowserClient.withTimeout(
        'new isolated context',
        this.#browser.newContext({ viewport: this.#config.viewport }),
      )
    }
    const context = this.#isolatedContext ?? this.#browser.contexts()[0]
    if (context === undefined) {
      throw new Error('default browser context absent')
    }
    const page = await BrowserClient.withTimeout('new page', context.newPage())
    return page
  }

  async release(page) {
    const errors = []
    try {
      await this.#closePage(page)
    } catch (error) {
      errors.push(error.message)
    } finally {
      try {
        await this.#releaseLease()
      } catch (error) {
        errors.push(`lease release: ${error.message}`)
      }
    }
    return errors
  }

  async #closePage(page) {
    const resource = this.#isolatedContext ?? page
    if (resource === undefined) {
      return
    }
    await BrowserClient.withTimeout(
      'close test page or context',
      resource.close(),
    )
    this.#isolatedContext = undefined
  }

  async #acquireLease() {
    // Waiting for the startup lock still counts as a running test.
    const leaseId = randomUUID()
    await mkdir(WAITERS_DIR, { recursive: true, mode: PRIVATE_DIR_MODE })
    const waiterPath = join(WAITERS_DIR, leaseId)
    const pendingPath = join(RUNTIME_DIR, `waiter-${leaseId}`)
    try {
      await writeFile(pendingPath, String(process.pid), {
        mode: PRIVATE_FILE_MODE,
      })
      await rename(pendingPath, waiterPath)
    } finally {
      await rm(pendingPath, { force: true })
    }
    try {
      return await this.#withLock(async () => {
        try {
          return await this.#leaseHost(leaseId)
        } finally {
          await rm(waiterPath)
        }
      })
    } catch (error) {
      await rm(waiterPath, { force: true })
      await this.#closeHostIfIdleLocked()
      throw new Error(`could not acquire test host lease: ${error.message}`, {
        cause: error,
      })
    }
  }

  async #closeHostIfIdleLocked() {
    await this.#withLock(async () => {
      const host = await this.#findRunningHost()
      if (host) {
        await this.#closeHostIfIdle(host, (await this.#readHostState()).leases)
      }
    })
  }

  async #leaseHost(leaseId) {
    const runningHost = await this.#findRunningHost()
    const { launchArgs = [], viewport = DEFAULT_VIEWPORT } = this.#config
    if (
      runningHost &&
      (JSON.stringify(runningHost.launchArgs) !== JSON.stringify(launchArgs) ||
        runningHost.viewport?.width !== viewport?.width ||
        runningHost.viewport?.height !== viewport?.height)
    ) {
      throw new Error('test host launch configuration does not match')
    }
    const host = runningHost ?? (await this.#launchHost())
    const { leases, applied } = await this.#readHostState()
    const newlyApplied = await this.#ensureFixtures(host)
    const allApplied = [
      ...new Set([...applied, ...this.#requires.map((f) => f.name)]),
    ]
    await this.#writeHostState(
      host,
      [...leases, { id: leaseId, pid: process.pid }],
      allApplied,
    )
    await BrowserHost.log({
      event: 'lease',
      ...host,
      testPid: process.pid,
      reused: !!runningHost,
      applied: newlyApplied,
    })
    return { ...host, leaseId, applied: allApplied }
  }

  async #launchHost() {
    const host = await new BrowserHost(this.#config).launch()
    // A fixture can fail before a lease exists; keep the host available for cleanup.
    await this.#writeHostState(host, [], [])
    // The persistent profile can already hold fixture state from an earlier host.
    const ready = await this.#withDefaultContext(host, async (context) => {
      const ready = []
      for (const fixture of this.#config.fixtures ?? []) {
        if (await fixture.isReady(context)) {
          ready.push(fixture.name)
        }
      }
      return ready
    })
    await this.#writeHostState(host, [], ready)
    return host
  }

  // Applies each required fixture that is not ready and returns the names it applied.
  async #ensureFixtures(host) {
    if (this.#requires.length === 0) {
      return []
    }
    return this.#withDefaultContext(host, async (context) => {
      const newlyApplied = []
      for (const fixture of this.#requires) {
        if (!(await fixture.isReady(context))) {
          await fixture.apply(context)
          newlyApplied.push(fixture.name)
        }
      }
      return newlyApplied
    })
  }

  async #withDefaultContext(host, operation) {
    const browser = await BrowserClient.#connect(host.endpoint)
    try {
      const context = browser.contexts()[0]
      if (context === undefined) {
        throw new Error('default browser context absent')
      }
      return await operation(context)
    } finally {
      // Closing a connectOverCDP client disconnects it, leaving Chromium alive.
      await browser.close()
    }
  }

  async #releaseLease() {
    if (this.#lease === undefined) {
      return
    }
    await this.#withLock(async () => {
      const { host, leases, applied } = await this.#readHostState()
      if (
        host.endpoint !== this.#lease.endpoint ||
        host.pid !== this.#lease.pid
      ) {
        throw new Error('test host changed before release')
      }
      if (!leases.some((entry) => entry.id === this.#lease.leaseId)) {
        throw new Error('test host lease missing')
      }
      const remaining = leases.filter(
        (entry) => entry.id !== this.#lease.leaseId,
      )
      await this.#writeHostState(host, remaining, applied)
      await this.#closeHostIfIdle(host, remaining)
      this.#lease = undefined
    })
  }

  async #closeHostIfIdle(host, leases) {
    const waiters = []
    for (const name of await readdir(WAITERS_DIR)) {
      const path = join(WAITERS_DIR, name)
      try {
        const pid = Number(await readFile(path, 'utf8'))
        if (BrowserClient.#isProcessAlive(pid)) {
          waiters.push(name)
        } else {
          await rm(path, { force: true })
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error
        }
      }
    }
    if (leases.length > 0 || waiters.length > 0) {
      return
    }
    const browser = await BrowserClient.#connect(host.endpoint)
    const session = await browser.newBrowserCDPSession()
    const disconnected = new Promise((resolve) =>
      browser.once('disconnected', resolve),
    )
    await session.send('Browser.close')
    await disconnected
    await rm(HOST_STATE_FILE)
    await BrowserHost.log({ event: 'closed', ...host })
  }

  async #withLock(operation) {
    await mkdir(RUNTIME_DIR, { recursive: true, mode: PRIVATE_DIR_MODE })
    await this.#acquireLock()
    try {
      return await operation()
    } finally {
      await rm(STARTUP_LOCK_DIR, { recursive: true, force: true })
    }
  }

  async #acquireLock() {
    const path = await mkdtemp(join(RUNTIME_DIR, 'startup-'))
    try {
      // Publish a nonempty directory atomically; no ownerless lock is visible.
      await writeFile(join(path, String(process.pid)), String(process.pid))
      const deadline = Date.now() + HOST_START_TIMEOUT_MS
      while (Date.now() < deadline) {
        try {
          await rename(path, STARTUP_LOCK_DIR)
          return
        } catch (error) {
          if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') {
            throw new Error('could not acquire host startup lock', {
              cause: error,
            })
          }
        }
        await this.#pruneLock()
        await sleep(LOCK_RETRY_MS)
      }
      throw new Error(
        `test host startup lock exceeded ${HOST_START_TIMEOUT_MS / 1000}s`,
      )
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  }

  async #pruneLock() {
    try {
      for (const name of await readdir(STARTUP_LOCK_DIR)) {
        const path = join(STARTUP_LOCK_DIR, name)
        const pid = Number(await readFile(path, 'utf8'))
        if (!BrowserClient.#isProcessAlive(pid)) {
          // Owner-specific names keep a late reaper from unlinking a live lock.
          // The fixed "pid" name is accepted for existing runtime directories.
          await rm(path, { force: true })
        }
      }
      await rmdir(STARTUP_LOCK_DIR)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
        throw error
      }
    }
  }

  static #isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('invalid browser test process id')
    }
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') {
        return false
      }
      if (error.code === 'EPERM') {
        return true
      }
      throw error
    }
  }

  async #readHostState() {
    const value = JSON.parse(await readFile(HOST_STATE_FILE, 'utf8'))
    const host = BrowserClient.parseHostState(value)
    const leases = BrowserClient.#parseLeases(value.leases).filter((lease) =>
      BrowserClient.#isProcessAlive(lease.pid),
    )
    const applied = BrowserClient.#parseApplied(value.applied)
    if (leases.length !== value.leases.length) {
      await this.#writeHostState(host, leases, applied)
    }
    return { host, leases, applied }
  }

  async #writeHostState(host, leases, applied) {
    await writeFile(
      HOST_STATE_FILE,
      `${JSON.stringify({
        ...BrowserClient.parseHostState(host),
        leases,
        applied,
      })}\n`,
      { mode: PRIVATE_FILE_MODE },
    )
  }

  async #findRunningHost() {
    let host
    try {
      host = (await this.#readHostState()).host
    } catch (error) {
      if (error.code === 'ENOENT') {
        return
      }
      throw new Error('could not read test host state', { cause: error })
    }
    try {
      const response = await fetch(`${host.endpoint}/json/version`, {
        signal: AbortSignal.timeout(HOST_CHECK_TIMEOUT_MS),
      })
      return response.ok ? host : undefined
    } catch (error) {
      if (
        error.name === 'TimeoutError' ||
        error.cause?.code === 'ECONNREFUSED'
      ) {
        return
      }
      throw new Error('could not check test host endpoint', {
        cause: error,
      })
    }
  }

  static #parseApplied(value) {
    if (
      !Array.isArray(value) ||
      !value.every((name) => typeof name === 'string' && name)
    ) {
      throw new Error('invalid test host applied fixtures')
    }
    return value
  }

  static #parseLeases(value) {
    const valid =
      Array.isArray(value) &&
      value.every(
        (lease) =>
          lease &&
          typeof lease.id === 'string' &&
          lease.id &&
          Number.isInteger(lease.pid) &&
          lease.pid > 0,
      )
    if (
      !valid ||
      new Set(value.map((lease) => lease.id)).size !== value.length
    ) {
      throw new Error('invalid test host leases')
    }
    return value
  }
}

class BrowserHost {
  static async log(event) {
    await appendFile(HOST_LOG_FILE, `${JSON.stringify(event)}\n`)
  }

  #launchArgs
  #viewport

  #port

  #context

  constructor({ launchArgs = [], viewport = DEFAULT_VIEWPORT } = {}) {
    this.#launchArgs = launchArgs
    this.#viewport = viewport
  }

  async launch() {
    const log = await open(HOST_LOG_FILE, 'a', PRIVATE_FILE_MODE)
    try {
      return await this.#waitForReady(log.fd)
    } finally {
      await log.close()
    }
  }

  async #waitForReady(logFd) {
    const child = spawn(
      process.execPath,
      [BROWSER_TEST_PATH, HOST_FLAG, `--headless=${HEADLESS ? 'yes' : 'no'}`],
      {
        detached: true,
        env: {
          ...process.env,
          [HOST_LAUNCH_ARGS_ENV]: JSON.stringify({
            launchArgs: this.#launchArgs,
            viewport: this.#viewport,
          }),
        },
        stdio: ['ignore', logFd, logFd, 'ipc'],
      },
    )
    const exited = new AbortController()
    const onExit = () =>
      exited.abort(new Error(`test host startup failed; see ${HOST_LOG_FILE}`))
    child.once('exit', onExit)
    const timeout = AbortSignal.timeout(HOST_START_TIMEOUT_MS)
    try {
      const [host] = await once(child, 'message', {
        signal: AbortSignal.any([timeout, exited.signal]),
      })
      child.unref()
      return BrowserClient.parseHostState(host)
    } catch (error) {
      throw BrowserHost.#startFailure(error, timeout, exited.signal)
    } finally {
      child.off('exit', onExit)
    }
  }

  static #startFailure(error, timeout, exited) {
    if (timeout.aborted) {
      return new Error(
        `test host startup exceeded ${HOST_START_TIMEOUT_MS / 1000}s; see ${HOST_LOG_FILE}`,
        { cause: error },
      )
    }
    if (exited.aborted) {
      return new Error(exited.reason.message, { cause: error })
    }
    return new Error('could not start test host', { cause: error })
  }

  async run() {
    try {
      this.#context = await this.#launchChromium()
      const host = this.#describe()
      process.stdout.write(`${JSON.stringify({ event: 'ready', ...host })}\n`)
      process.send?.(host)
      process.disconnect?.()
    } catch (error) {
      try {
        throw new Error(`could not run test host: ${error.message}`, {
          cause: error,
        })
      } finally {
        await this.#context?.close()
      }
    }
  }

  async #launchChromium() {
    const position = HEADLESS ? [] : await this.#windowPosition()
    const userAgentArgs = []
    if (HEADLESS) {
      const version = execFileSync(chromium.executablePath(), ['--version'], {
        encoding: 'utf8',
      }).trim()
      const match = version.match(/\b(\d+)\.\d+\.\d+\.\d+\b/)
      if (!match) {
        throw new Error(`could not parse Chromium version: ${version}`)
      }
      userAgentArgs.push(
        `--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${match[1]}.0.0.0 Safari/537.36`,
      )
    }
    this.#port = await this.#findFreePort()
    return chromium.launchPersistentContext(join(RUNTIME_DIR, 'profile'), {
      headless: HEADLESS,
      viewport: this.#viewport,
      args: [
        ...position,
        `--remote-debugging-port=${this.#port}`,
        `--remote-debugging-address=${LOOPBACK}`,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        ...userAgentArgs,
        ...this.#launchArgs,
      ],
    })
  }

  #describe() {
    return {
      endpoint: `http://${LOOPBACK}:${this.#port}`,
      pid: process.pid,
      launchArgs: this.#launchArgs,
      viewport: this.#viewport,
    }
  }

  async #findFreePort() {
    const listener = createServer()
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(0, LOOPBACK, resolve)
      })
      return listener.address().port
    } finally {
      if (listener.listening) {
        await new Promise((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        )
      }
    }
  }

  async #windowPosition() {
    const name = await this.#readDisplayConfig()
    if (!name) {
      return []
    }
    const displays = this.#listDisplays()
    const display = displays.find((display) =>
      display.name.toLowerCase().includes(name.toLowerCase()),
    )
    if (!display) {
      throw new Error(
        `BROWSER_DISPLAY=${JSON.stringify(
          name,
        )} did not match any macOS display; available: ${
          displays.map((display) => display.name).join(', ') || '(none)'
        }`,
      )
    }
    // NSScreen's first screen is primary; Cocoa's Y axis points upward.
    // Use the visible frame to keep the window clear of the menu bar and Dock.
    const primary = displays[0].frame
    const { origin, size } = display.visibleFrame
    return [
      `--window-position=${Math.round(origin.x)},${Math.round(
        primary.origin.y + primary.size.height - origin.y - size.height,
      )}`,
    ]
  }

  async #readDisplayConfig() {
    try {
      return (
        parseEnv(
          await readFile(join(REPO_ROOT, '.browser-tests', '.env'), 'utf8'),
        ).BROWSER_DISPLAY ?? ''
      )
    } catch (error) {
      if (error.code === 'ENOENT') {
        return ''
      }
      throw new Error('could not read browser test display configuration', {
        cause: error,
      })
    }
  }

  #listDisplays() {
    return JSON.parse(
      execFileSync(
        'osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `ObjC.import('AppKit')
const screens = $.NSScreen.screens
const displays = []
for (let i = 0; i < screens.count; i++) {
  const screen = screens.objectAtIndex(i)
  displays.push({
    name: ObjC.unwrap(screen.localizedName),
    frame: screen.frame,
    visibleFrame: screen.visibleFrame,
  })
}
JSON.stringify(displays)`,
        ],
        { encoding: 'utf8', timeout: OPERATION_TIMEOUT_MS },
      ),
    )
  }
}

/**
 * Starts a browser test with its own Page in shared Chromium.
 * @param {{ test?: string, requires?: string[] }} [options] Inventory behavior and the names of the fixtures the test needs; a fixture applied to the shared browser but not required gets the test an isolated context.
 * @param {{ baseUrl: string, fixtures?: Array<{ name: string, isReady: (context: import('playwright').BrowserContext) => Promise<boolean>, apply: (context: import('playwright').BrowserContext) => Promise<void> }>, launchArgs?: string[], viewport?: { width: number, height: number } | null }} config The project's base URL, fixtures, extra Chromium launch arguments and viewport; null uses the window size.
 * @returns {Promise<BrowserTest>} The page-owning test; finish() emits its verdict and exits.
 * @throws {Error} Startup errors are handled by emitting an inconclusive verdict and exiting.
 */
export async function startBrowserTest(
  { test: behavior, requires = [] } = {},
  config,
) {
  const client = new BrowserClient(config)
  const test = new BrowserTest({ client, baseUrl: config.baseUrl, behavior })
  const fail = (error) =>
    test.finish({
      verdict: 'inconclusive',
      errors: [error instanceof Error ? error.message : String(error)],
    })
  process.once('uncaughtException', fail)
  process.once('unhandledRejection', fail)
  process.on('SIGINT', () => fail(new Error('test interrupted: SIGINT')))
  process.on('SIGTERM', () => fail(new Error('test interrupted: SIGTERM')))
  process.once('beforeExit', () =>
    fail(new Error('test exited without finish()')),
  )
  try {
    if (process.env.CODEX_SANDBOX) {
      throw new Error('browser test must run outside the sandbox (escalated)')
    }
    test.page = await client.openPage(requires)
    return test
  } catch (error) {
    await fail(error)
  }
}

if (process.argv[1] === BROWSER_TEST_PATH && process.argv[2] === HOST_FLAG) {
  new BrowserHost(JSON.parse(process.env[HOST_LAUNCH_ARGS_ENV]))
    .run()
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}
