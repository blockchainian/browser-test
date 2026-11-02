import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const PROBE = fileURLToPath(new URL('probe.mjs', import.meta.url))
const RUNTIME_DIR = fileURLToPath(
  new URL('../.browser-tests/headless', import.meta.url),
)

const HOST_STATE_FILE = `${RUNTIME_DIR}/host.json`

function startProbe(env) {
  const child = spawn(process.execPath, [PROBE, '--headless=yes'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = once(child, 'exit').then(() => {
    const verdict = JSON.parse(stdout.trim().split('\n').at(-1))
    return { verdict, stderr }
  })
  return {
    child,
    done,
    get stderr() {
      return stderr
    },
  }
}

async function waitForHeld(probe) {
  while (!probe.stderr.includes('held')) {
    if (probe.child.exitCode !== null) {
      throw new Error(`probe exited early: ${probe.stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

let server
let url

before(async () => {
  await rm(RUNTIME_DIR, { recursive: true, force: true })
  server = createServer((request, response) => {
    if (request.url === '/ua/sw.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(`
        self.addEventListener('activate', (event) => {
          event.waitUntil(self.clients.claim())
        })
        self.addEventListener('fetch', (event) => {
          if (new URL(event.request.url).pathname === '/ua/user-agent') {
            event.respondWith(new Response(self.navigator.userAgent))
          }
        })
      `)
      return
    }
    if (request.url === '/ua/user-agent') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>probe</title>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${server.address().port}/`
})

after(() => server.close())

test('verdict reports the behavior and total elapsed milliseconds', async () => {
  const { verdict, stderr } = await startProbe({ PROBE_URL: url }).done
  assert.equal(verdict.verdict, 'pass', stderr)
  assert.equal(verdict.test, 'fixture visibility')
  assert.ok(Number.isInteger(verdict.timing.total))
  assert.ok(verdict.timing.total >= 0)
  assert.ok(!Object.hasOwn(verdict.timing, 'total_s'))
})

test('headless test and host pages use a Chrome user agent', async () => {
  const probe = startProbe({ PROBE_URL: url, PROBE_HOLD: '1' })
  try {
    await waitForHeld(probe)
    const state = JSON.parse(await readFile(HOST_STATE_FILE, 'utf8'))
    const browser = await chromium.connectOverCDP(state.endpoint)
    try {
      for (const page of browser.contexts()[0].pages()) {
        assert.doesNotMatch(
          await page.evaluate(() => navigator.userAgent),
          /HeadlessChrome/,
        )
      }
      const page = browser.contexts()[0].pages()[0]
      await page.goto(new URL('ua/', url).href)
      assert.doesNotMatch(
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.register('sw.js')
          try {
            await navigator.serviceWorker.ready
            if (!navigator.serviceWorker.controller) {
              await new Promise((resolve) => {
                navigator.serviceWorker.addEventListener(
                  'controllerchange',
                  resolve,
                  { once: true },
                )
              })
            }
            const response = await fetch('user-agent')
            if (!response.ok) {
              throw new Error(
                `Service Worker UA request failed: ${response.status}`,
              )
            }
            return await response.text()
          } finally {
            await registration.unregister()
          }
        }),
        /HeadlessChrome/,
      )
    } finally {
      await browser.close()
    }
    probe.child.stdin.end()
    const { verdict, stderr } = await probe.done
    assert.equal(verdict.verdict, 'pass', stderr)
  } finally {
    probe.child.stdin.end()
    await probe.done
  }
})

test('fixture state is shared with tests that require it and hidden from others', async () => {
  // The first test holds its lease, so the browser that applied the fixture stays up.
  const requiring = startProbe({
    PROBE_URL: url,
    PROBE_REQUIRES: 'key',
    PROBE_HOLD: '1',
  })
  try {
    await waitForHeld(requiring)
    const plain = await startProbe({ PROBE_URL: url }).done
    assert.equal(plain.verdict.verdict, 'pass', plain.stderr)
    assert.equal(plain.verdict.checks[0].evidence, 'null')

    requiring.child.stdin.end()
    const { verdict } = await requiring.done
    assert.equal(verdict.verdict, 'pass')
    assert.equal(verdict.checks[0].evidence, 'set')
  } finally {
    requiring.child.kill()
  }
})

test('fixture state kept in the profile is hidden from tests on a new host', async () => {
  // The previous test's host has closed, but its profile still holds the key.
  const plain = startProbe({ PROBE_URL: url, PROBE_HOLD: '1' })
  try {
    await waitForHeld(plain)

    // The new host recorded the key fixture as applied from the profile alone.
    const state = JSON.parse(await readFile(HOST_STATE_FILE, 'utf8'))
    assert.deepEqual(state.applied, ['key'])

    // The shared default context still has the key; only the test is isolated.
    const browser = await chromium.connectOverCDP(state.endpoint)
    try {
      const page = await browser.contexts()[0].newPage()
      await page.goto(url)
      assert.equal(
        await page.evaluate(() => localStorage.getItem('key')),
        'set',
      )
      await page.close()
    } finally {
      await browser.close()
    }

    plain.child.stdin.end()
    const { verdict, stderr } = await plain.done
    assert.equal(verdict.verdict, 'pass', stderr)
    assert.equal(verdict.checks[0].evidence, 'null')
  } finally {
    plain.child.kill()
  }
})

test('viewport null uses the window size in shared and isolated contexts', async () => {
  for (const requires of ['key', '']) {
    const probe = startProbe({
      PROBE_URL: url,
      PROBE_REQUIRES: requires,
      PROBE_VIEWPORT: 'null',
      PROBE_HOLD: '1',
    })
    try {
      await waitForHeld(probe)
      const state = JSON.parse(await readFile(HOST_STATE_FILE, 'utf8'))
      assert.equal(state.viewport, null)
      probe.child.stdin.end()
      const { verdict, stderr } = await probe.done
      assert.equal(verdict.verdict, 'pass', stderr)
      assert.equal(verdict.checks[1].evidence, 'null')
    } finally {
      probe.child.stdin.end()
      await probe.done
    }
  }
})

test('a running host cannot be reused with a different viewport', async () => {
  const held = startProbe({ PROBE_URL: url, PROBE_HOLD: '1' })
  try {
    await waitForHeld(held)
    const same = await startProbe({
      PROBE_URL: url,
      PROBE_VIEWPORT: '{"width":1440,"height":900}',
    }).done
    assert.equal(same.verdict.verdict, 'pass', same.stderr)
    const { verdict } = await startProbe({
      PROBE_URL: url,
      PROBE_VIEWPORT: 'null',
    }).done
    assert.equal(verdict.verdict, 'inconclusive')
    assert.match(verdict.errors.test[0], /launch configuration does not match/)
  } finally {
    held.child.stdin.end()
    await held.done
  }
})
