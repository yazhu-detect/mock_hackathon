import { chromium } from 'playwright'

const shotDir =
  process.env.SHOT_DIR ||
  '/private/tmp/claude-501/-Users-augustinmuyl-dev-mock-hackathon/077aea6b-2bcc-4ad2-9a43-96c3de5d5d31/scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1512, height: 950 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

async function clickChip(text) {
  await page.getByRole('button', { name: new RegExp(text, 'i') }).first().click()
  await page.waitForTimeout(1300)
}

// Home
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: shotDir + '/01-home.png' })

// Dispatch
await page.goto('http://localhost:5173/dispatch', { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await page.screenshot({ path: shotDir + '/02-dispatch-idle.png' })

await clickChip('paste intake')
await page.screenshot({ path: shotDir + '/03-intake.png' })

await clickChip('schedule everything')
await page.screenshot({ path: shotDir + '/04-scheduled.png', fullPage: true })

await clickChip('weekend overtime')
await page.screenshot({ path: shotDir + '/05-overtime.png' })

await clickChip('coach whom')
await page.screenshot({ path: shotDir + '/06-coaching.png', fullPage: true })

// Coaching pairing flow: accept the first pair, then book the 1h session.
await page.getByRole('button', { name: /Accept pair/i }).first().click()
await page.waitForTimeout(900)
await page.getByRole('button', { name: /Book 1h session/i }).first().click()
await page.waitForTimeout(1000)
await page.screenshot({ path: shotDir + '/07-coaching-booked.png', fullPage: true })

// Cycle the coaching layout variants.
for (const lay of ['board', 'focus', 'pairs']) {
  await page.getByRole('button', { name: new RegExp('^' + lay + '$', 'i') }).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: shotDir + `/08-coaching-${lay}.png`, fullPage: true })
}

const body = await page.locator('body').innerText()
const grab = (re) => (body.match(re) || []).slice(0, 6)

console.log('CONSOLE ERRORS:', errors.length ? errors : 'none')
console.log('has req601:', body.includes('601'))
console.log('has Analyst board:', body.includes('Analyst board'))
console.log('has Coaching pairings:', body.includes('Coaching pairings'))
console.log('fit labels:', grab(/\d+% fit/g))
console.log('at-risk labels:', grab(/\d+d late|Zero slack|Overflow/g))
console.log('booked session:', grab(/Booked Jul \d+/g))

await browser.close()
