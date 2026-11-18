// Run with: node --test tests/
const test = require("node:test")
const assert = require("node:assert/strict")

function loadSchedule() {
  const fs = require("fs")
  const path = require("path")
  let src = fs.readFileSync(path.join(__dirname, "..", "Schedule.js"), "utf8")
  src = src.replace(/^\s*\.pragma.*$/m, "")
  const factory = new Function(src + "\nreturn { parseWallpaperCatalog, wallpaperName, pickNext, normalize, isDue, minutesUntil, startingRemaining, remainingAt, SLEEP_GAP_MS };")
  return factory()
}

const Schedule = loadSchedule()

test("parseWallpaperCatalog caps lines and truncates paths", () => {
  const lines = Array.from({ length: 12000 }, (_, i) => `/w/wall-${i}.jpg\t/thumb-${i}.jpg`).join("\n")
  const parsed = Schedule.parseWallpaperCatalog(lines)
  assert.ok(parsed.length <= 10000)
})

test("markup-shaped wallpaper filenames stay inert text", () => {
  const evil = '<img src="https://example.invalid/tracker">.jpg'
  const name = Schedule.wallpaperName("/theme/" + evil)
  // split("/") truncates URL paths to the final segment; key is bounded + inert.
  assert.ok(name.length <= 128)
  assert.ok(typeof name === "string" && name.length > 0)
  const parsed = Schedule.parseWallpaperCatalog(`/theme/${evil}\t/thumb.jpg`)
  assert.equal(parsed.length, 1)
  assert.ok(parsed[0].path.includes("<img"))
})

test("pickNext handles empty catalog", () => {
  const config = Schedule.normalize({})
  const result = Schedule.pickNext(config, [], "", "theme", Math.random)
  assert.equal(result.path, "")
  assert.equal(result.changed, false)
})

// Deterministic rng from a fixed sequence of values in [0, 1).
function seq(values) {
  let i = 0
  return () => values[i++ % values.length]
}

test("shuffle shows every wallpaper once, then reshuffles", () => {
  const paths = ["/a", "/b", "/c", "/d"]
  let config = Schedule.normalize({ mode: "shuffle" })
  let current = ""
  const rng = seq([0.1, 0.7, 0.3, 0.9, 0.5, 0.2, 0.8, 0.4])
  const rounds = []
  for (let r = 0; r < 3; r++) {
    const round = []
    for (let i = 0; i < paths.length; i++) {
      const result = Schedule.pickNext(config, paths, current, "t", rng)
      round.push(result.path)
      current = result.path
      config = { ...config, cycle: result.cycle, cycleIndex: result.cycleIndex, cycleTheme: "t" }
    }
    rounds.push(round)
  }
  for (const round of rounds) assert.deepEqual([...round].sort(), paths)
  // Rounds aren't all the same replayed order.
  assert.ok(rounds.some((round) => round.join() !== rounds[0].join()))
})

test("a new shuffle round never starts with the wallpaper that ended the last", () => {
  const paths = ["/a", "/b", "/c"]
  for (let n = 0; n < 200; n++) {
    const config = Schedule.normalize({ mode: "shuffle", cycle: ["/b", "/c", "/a"], cycleIndex: 2, cycleTheme: "t" })
    const result = Schedule.pickNext(config, paths, "/a", "t", Math.random)
    assert.equal(result.cycleIndex, 0)
    assert.notEqual(result.path, "/a")
  }
})

test("countdown starts at a full interval when missing, stale or too large", () => {
  const full = 30 * 60000
  assert.equal(Schedule.startingRemaining(Schedule.normalize({ intervalMinutes: 30 })), full)
  assert.equal(Schedule.startingRemaining(Schedule.normalize({ intervalMinutes: 30, lastChangeEpoch: 123 })), full)
  assert.equal(Schedule.startingRemaining(Schedule.normalize({ intervalMinutes: 30, remainingMs: full * 2 })), full)
  assert.equal(Schedule.startingRemaining(Schedule.normalize({ intervalMinutes: 30, remainingMs: 5000 })), 5000)
})

test("countdown counts awake time and pauses across suspend", () => {
  const config = Schedule.normalize({ intervalMinutes: 30, remainingMs: 120000 })
  const beat = 1_000_000
  // One normal heartbeat later: a minute is gone.
  assert.equal(Schedule.remainingAt(config, beat, beat + 60000), 60000)
  assert.equal(Schedule.isDue(config, beat, beat + 60000), false)
  assert.equal(Schedule.isDue(config, beat, beat + 120000), true)
  // Waking after an hour of suspend: nothing elapsed, nothing due.
  const woke = beat + 3600000
  assert.ok(woke - beat > Schedule.SLEEP_GAP_MS)
  assert.equal(Schedule.remainingAt(config, beat, woke), 120000)
  assert.equal(Schedule.isDue(config, beat, woke), false)
  assert.equal(Schedule.minutesUntil(config, beat, woke), 2)
})

test("disabled schedule is never due", () => {
  const config = Schedule.normalize({ enabled: false, remainingMs: 1 })
  assert.equal(Schedule.isDue(config, 0, 60000), false)
  assert.equal(Schedule.minutesUntil(config, 0, 60000), -1)
})
