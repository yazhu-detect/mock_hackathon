import { chromium } from 'playwright'

const shotDir = '/private/tmp/claude-501/-Users-yazhu-Desktop-mock-hackathon/70a323c7-5125-47ed-9752-2949bcbc5ed0/scratchpad'
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

await clickChip('needs coaching')
await page.screenshot({ path: shotDir + '/06-coaching.png', fullPage: true })

// snapshot key on-screen numbers
const kpiTexts = await page.locator('text=/AT RISK|SCHEDULED|INCOMING VOLUME|TEAM SUPPLY/').allInnerTexts().catch(() => [])
const body = await page.locator('body').innerText()
const grab = (re) => (body.match(re) || []).slice(0, 6)

console.log('CONSOLE ERRORS:', errors.length ? errors : 'none')
console.log('has req601:', body.includes('601'))
console.log('coaching mentions primary coach:', body.includes('Primary coach'))
console.log('at-risk labels:', grab(/\d+d late|Zero slack|Overflow/g))
console.log('coach pairings:', grab(/Primary coach: [A-Z][a-z]+ [A-Z][a-z]+/g))
console.log('consult:', grab(/Consult: [A-Z][a-z]+ [A-Z][a-z]+/g))

await browser.close()
