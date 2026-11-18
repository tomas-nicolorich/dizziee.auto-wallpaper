.pragma library

var DEFAULTS = {
  enabled: true,
  intervalMinutes: 30,
  mode: "sequential",
  remainingMs: 0,
  cycle: [],
  cycleIndex: 0,
  cycleTheme: ""
}

var MODE_SEQUENTIAL = "sequential"
var MODE_SHUFFLE = "shuffle"

function integer(value, fallback) {
  var parsed = Number(value)
  return isFinite(parsed) && Math.floor(parsed) === parsed ? parsed : fallback
}

function interval(value, fallback) {
  var parsed = integer(value, fallback)
  return parsed >= 1 && parsed <= 1440 ? parsed : fallback
}

function mode(value, fallback) {
  return value === MODE_SHUFFLE ? MODE_SHUFFLE : MODE_SEQUENTIAL
}

function remaining(value) {
  var parsed = Number(value)
  return isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function normalize(raw) {
  var source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULTS.enabled,
    intervalMinutes: interval(source.intervalMinutes, DEFAULTS.intervalMinutes),
    mode: mode(source.mode, DEFAULTS.mode),
    remainingMs: remaining(source.remainingMs),
    cycle: Array.isArray(source.cycle) ? source.cycle.slice() : [],
    cycleIndex: integer(source.cycleIndex, DEFAULTS.cycleIndex),
    cycleTheme: typeof source.cycleTheme === "string" ? source.cycleTheme : ""
  }
}

// Parse the catalog script's tab-separated rows "<path>\t<thumbnail path>"
// into an array of { path, thumb }. Blank lines are ignored; a row without a
// thumbnail column falls back to the original path.
var MAX_CATALOG_LINES = 10000
var MAX_PATH_LEN = 1024

function boundPath(value) {
  var s = String(value || "").trim()
  return s.length > MAX_PATH_LEN ? s.slice(0, MAX_PATH_LEN) : s
}

function parseWallpaperCatalog(text) {
  var result = []
  var seen = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length && result.length < MAX_CATALOG_LINES; i++) {
    var fields = lines[i].split("\t")
    var path = boundPath(fields[0])
    if (!path || seen[path]) continue
    seen[path] = true
    var thumb = boundPath(fields[1])
    result.push({ path: path, thumb: thumb || path })
  }
  return result
}

// Turn a wallpaper path into a short, human-readable display name.
function wallpaperName(path) {
  var base = boundPath(path).replace(/\\/g, "/").split("/").pop()
  base = base.replace(/\.[^.]+$/, "")
  if (!base) return "Unknown"
  base = base.replace(/[-_.]+/g, " ")
  return base.replace(/\b[a-z]/g, function(letter) { return letter.toUpperCase() })
    .replace(/\s+/g, " ").trim().slice(0, 128)
}

// Fisher-Yates shuffle. `rng` is optional to support deterministic tests.
function shuffle(values, rng) {
  var a = Array.isArray(values) ? values.slice() : []
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor((rng ? rng() : Math.random()) * (i + 1))
    var t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

function sameSet(left, right) {
  if (left.length !== right.length) return false
  var sortedL = left.slice().sort()
  var sortedR = right.slice().sort()
  for (var i = 0; i < sortedL.length; i++)
    if (sortedL[i] !== sortedR[i]) return false
  return true
}

// A persisted shuffle cycle stays valid only while the theme is unchanged and
// the catalog still contains exactly the same paths.
function cycleStillValid(cycle, catalog, cycleTheme, theme) {
  if (cycleTheme !== theme || !Array.isArray(cycle)) return false
  return sameSet(cycle, catalog)
}
// Compute the next wallpaper for the given catalog and current selection. Pure
// and deterministic given a fixed rng. Returns the target path ("" when there
// is nothing to change to) plus the shuffle bookkeeping that must be saved.
//
// Sequential: advance one slot past the current wallpaper, wrapping around.
// Shuffle: step a persisted, never-repeating cycle. The cycle is rebuilt when
// the theme or catalog changes, then resumes from wherever the current
// wallpaper sits so manual picks stay part of the rotation.
function pickNext(config, catalog, currentPath, theme, rng) {
  var paths = Array.isArray(catalog) ? catalog.slice() : []
  if (paths.length === 0)
    return { path: "", cycle: [], cycleIndex: 0, changed: false }

  var cycle
  var cycleIndex

  if (config.mode === MODE_SHUFFLE) {
    if (cycleStillValid(config.cycle, paths, config.cycleTheme, theme)) {
      cycle = config.cycle.slice()
      cycleIndex = config.cycleIndex || 0
    } else {
      cycle = shuffle(paths, rng)
      var idx = currentPath ? cycle.indexOf(currentPath) : -1
      cycleIndex = idx >= 0 ? idx : -1
    }

    if (cycle.length <= 1)
      return { path: "", cycle: cycle, cycleIndex: cycleIndex, changed: false }

    var nextShuffle = cycleIndex + 1
    if (nextShuffle >= cycle.length) {
      // Every wallpaper has been shown once: start a fresh random order
      // instead of replaying the same one, and don't open the new round with
      // the wallpaper that just ended the old one.
      cycle = shuffle(paths, rng)
      if (cycle[0] === currentPath) {
        var first = cycle[0]
        cycle[0] = cycle[1]
        cycle[1] = first
      }
      nextShuffle = 0
    }
    return {
      path: cycle[nextShuffle],
      cycle: cycle,
      cycleIndex: nextShuffle,
      changed: cycle[nextShuffle] !== currentPath
    }
  }

  var at = currentPath ? paths.indexOf(currentPath) : -1
  if (paths.length <= 1)
    return { path: "", cycle: [], cycleIndex: 0, changed: false }
  var nextSeq = at >= 0 ? (at + 1) % paths.length : 0
  return {
    path: paths[nextSeq],
    cycle: [],
    cycleIndex: 0,
    changed: paths[nextSeq] !== currentPath
  }
}

// The countdown only runs while the session is awake. `remainingMs` is the
// active time left; the service subtracts the time since its last heartbeat
// (`lastBeatEpoch`, kept in memory only). A gap longer than SLEEP_GAP_MS means
// the machine was suspended or the shell wasn't running (logged out), so that
// gap doesn't count: the countdown pauses across it instead of firing an
// overdue change the moment the machine wakes.
var HEARTBEAT_MS = 60000
var SLEEP_GAP_MS = HEARTBEAT_MS * 3

function intervalMs(config) {
  return (config.intervalMinutes || 0) * 60000
}

// Active time elapsed since the last heartbeat, ignoring suspend/logout gaps.
function activeElapsed(lastBeatEpoch, nowEpoch) {
  var gap = nowEpoch - lastBeatEpoch
  return gap > 0 && gap <= SLEEP_GAP_MS ? gap : 0
}

// A missing, stale or too-large remainingMs (new install, pre-fork config,
// interval just lowered) falls back to a full interval.
function startingRemaining(config) {
  var full = intervalMs(config)
  return config.remainingMs > 0 && config.remainingMs <= full ? config.remainingMs : full
}

function remainingAt(config, lastBeatEpoch, nowEpoch) {
  return Math.max(0, config.remainingMs - activeElapsed(lastBeatEpoch, nowEpoch))
}

// Is a scheduled change due right now?
function isDue(config, lastBeatEpoch, nowEpoch) {
  if (!config.enabled) return false
  return remainingAt(config, lastBeatEpoch, nowEpoch) <= 0
}

// Whole minutes until the next scheduled change (ceil). -1 when automation off.
function minutesUntil(config, lastBeatEpoch, nowEpoch) {
  if (!config.enabled) return -1
  var left = remainingAt(config, lastBeatEpoch, nowEpoch)
  if (left < 1) left = 1
  return Math.ceil(left / 60000)
}

function modeLabel(modeValue) {
  return modeValue === MODE_SHUFFLE ? "Shuffle" : "Sequential"
}

function intervalLabel(minutes) {
  var value = interval(minutes, 60)
  if (value < 60) return "Every " + value + " min"
  var hours = value / 60
  if (value % 60 === 0) return "Every " + hours + (hours === 1 ? " hour" : " hours")
  return "Every " + value + " min"
}

function intervalOptions() {
  var steps = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440]
  var options = []
  for (var i = 0; i < steps.length; i++) {
    var minutes = steps[i]
    options.push({ value: String(minutes), label: intervalLabel(minutes) })
  }
  return options
}

function modeOptions() {
  return [
    { value: MODE_SEQUENTIAL, label: "Sequential" },
    { value: MODE_SHUFFLE, label: "Shuffle" }
  ]
}

