// ABOUTME: Browser test run by smoke.test.mjs as its own process, as a consumer would write one.
// ABOUTME: Reports whether the localStorage key set by the fixture is visible to its page.
import { startBrowserTest } from '../src/index.mjs'

const baseUrl = process.env.PROBE_URL
const requires = process.env.PROBE_REQUIRES ? [process.env.PROBE_REQUIRES] : []

const keyFixture = {
  name: 'key',
  async isReady(context) {
    const page = await context.newPage()
    try {
      await page.goto(baseUrl)
      return (await page.evaluate(() => localStorage.getItem('key'))) === 'set'
    } finally {
      await page.close()
    }
  },
  async apply(context) {
    const page = await context.newPage()
    try {
      await page.goto(baseUrl)
      await page.evaluate(() => localStorage.setItem('key', 'set'))
    } finally {
      await page.close()
    }
  },
}

const test = await startBrowserTest(
  { test: 'fixture visibility', requires },
  { baseUrl, fixtures: [keyFixture] },
)
await test.page.goto(test.baseUrl)
const value = await test.page.evaluate(() => localStorage.getItem('key'))
test.check('key value', 'pass', String(value))

if (process.env.PROBE_HOLD) {
  // Keeps the lease so the shared browser stays up while another test runs.
  process.stderr.write('held\n')
  await new Promise((resolve) => process.stdin.once('end', resolve).resume())
}
await test.finish('fixture visibility')
