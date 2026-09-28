"use strict"

// These tests never talk to Hyprland. Anything that would run `hyprctl` is
// pointed at a stub script that only records its arguments.

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const repoLogic = path.join(__dirname, "..", "plugin", "sd.displays", "run", "DisplaysLogic.js")
const logic = require(repoLogic)
const monitorsJson = fs.readFileSync(path.join(__dirname, "fixtures", "monitors.json"), "utf8")
const monitorsLua = fs.readFileSync(path.join(__dirname, "fixtures", "monitors.lua"), "utf8")

const DELL = "DP-2"
const SAMSUNG = "HDMI-A-1"

function fixtureLayout() {
  return logic.arrangeable(logic.parseMonitors(monitorsJson))
}

function display(name, x, y, width, height, scale, extra) {
  return Object.assign({
    id: 0, name: name, description: name + " panel", make: "", model: name, serial: "",
    width: width, height: height, refresh: 60, x: x, y: y, scale: scale || 1, transform: 0,
    disabled: false, mirrorOf: "none", focused: false,
    modes: logic.parseModes([width + "x" + height + "@60.00Hz"])
  }, extra || {})
}

function position(layout, name) {
  const entry = logic.entryByName(layout, name)
  return [entry.x, entry.y]
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omarchy-displays-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A stand-in for hyprctl that appends its arguments to a log. Per command:
// STUB_RELOAD_EXIT / STUB_EVAL_EXIT set the exit code and
// STUB_RELOAD_OUT / STUB_EVAL_OUT what it prints (default "ok").
function stubHyprctl(dir) {
  const log = path.join(dir, "hyprctl.log")
  const bin = path.join(dir, "hyprctl")
  fs.writeFileSync(bin, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"" + log + "\"",
    "case \"$1\" in",
    "  reload) printf '%s\\n' \"${STUB_RELOAD_OUT:-ok}\"; exit \"${STUB_RELOAD_EXIT:-0}\" ;;",
    "  eval) printf '%s\\n' \"${STUB_EVAL_OUT:-ok}\"; exit \"${STUB_EVAL_EXIT:-0}\" ;;",
    "esac",
    "exit 0"
  ].join("\n") + "\n", { mode: 0o755 })
  return { bin: bin, log: log, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" }
}

function runScript(script, label, args, env) {
  return spawnSync("sh", ["-c", script, label].concat(args), {
    encoding: "utf8",
    env: Object.assign({}, process.env, env || {})
  })
}

test("tests require the repo plugin module, not an installed copy", () => {
  assert.equal(require.resolve(repoLogic), path.resolve(repoLogic))
  assert.match(repoLogic, /plugin\/sd\.displays\/run\/DisplaysLogic\.js$/)
})

// ------------------------------------------------------------------ modes

test("parseMode reads hyprctl mode strings", () => {
  assert.deepEqual(logic.parseMode("2560x1440@59.95Hz"),
    { width: 2560, height: 1440, refresh: 59.95, key: "2560x1440@59.95" })
  assert.equal(logic.parseMode("3840x2160@30.00Hz").key, "3840x2160@30")
  assert.equal(logic.parseMode("1920x1080@60").key, "1920x1080@60")
  assert.equal(logic.parseMode("preferred"), null)
  assert.equal(logic.parseMode("0x0@60.00Hz"), null)
  assert.equal(logic.parseMode(""), null)
})

test("parseModes drops the duplicates hyprctl reports", () => {
  const modes = logic.parseModes(["1920x1080@60.00Hz", "1920x1080@60.00Hz", "1920x1080@59.94Hz", "junk"])
  assert.deepEqual(modes.map((m) => m.key), ["1920x1080@60", "1920x1080@59.94"])
})

test("resolution and refresh options come from the available modes", () => {
  const samsung = logic.entryByName(fixtureLayout(), SAMSUNG)
  const options = logic.resolutionOptions(samsung)
  assert.equal(options[0].key, "3840x2160")
  assert.deepEqual(options[0].refreshRates, [30, 29.97, 25, 24, 23.98])
  assert.equal(options[1].key, "2560x1440")
  for (let i = 1; i < options.length; i++)
    assert.ok(options[i - 1].width * options[i - 1].height >= options[i].width * options[i].height)
  assert.deepEqual(logic.refreshOptions(samsung, 2560, 1440), [59.95])
  assert.deepEqual(logic.refreshOptions(samsung, 1, 1), [])
})

// ------------------------------------------------------------------ scale

test("cleanScale rounds up to a scale Hyprland accepts", () => {
  assert.equal(logic.cleanScale(1, 2560, 1440), 1)
  assert.equal(logic.cleanScale(2, 2560, 1440), 2)
  assert.equal(logic.cleanScale(1.5, 3840, 2160), 1.5)
  // 2560/1.5 is not a whole pixel count; 1.6 is the next clean scale.
  assert.equal(logic.cleanScale(1.5, 2560, 1440), 1.6)
  assert.equal(logic.cleanScale(0, 2560, 1440), 0)
  assert.equal(logic.cleanScale("x", 2560, 1440), 0)
  assert.equal(logic.cleanScale(1, 0, 1440), 0)
})

test("every clean scale gives whole logical pixels", () => {
  for (const [w, h] of [[2560, 1440], [3840, 2160], [1920, 1080], [2880, 1800], [1366, 768]]) {
    for (const preset of logic.SCALE_PRESETS) {
      const scale = logic.cleanScale(preset, w, h)
      assert.ok(scale > 0)
      assert.ok(Math.abs(w / scale - Math.round(w / scale)) < 1e-3, w + "/" + scale)
      assert.ok(Math.abs(h / scale - Math.round(h / scale)) < 1e-3, h + "/" + scale)
    }
  }
})

test("scaleOptions are ascending, unique, and include the current scale", () => {
  const layout = fixtureLayout()
  const dell = logic.scaleOptions(logic.entryByName(layout, DELL)).map((o) => o.value)
  assert.deepEqual(dell, dell.slice().sort((a, b) => a - b))
  assert.equal(new Set(dell).size, dell.length)
  assert.ok(dell.includes(1))
  const samsung = logic.scaleOptions(logic.entryByName(layout, SAMSUNG)).map((o) => o.value)
  assert.ok(samsung.includes(1.5))
})

// --------------------------------------------------------------- monitors

test("parseMonitors reads the hyprctl fixture", () => {
  const monitors = logic.parseMonitors(monitorsJson)
  assert.equal(monitors.length, 2)
  assert.deepEqual(monitors.map((m) => m.name), [DELL, SAMSUNG])
  const dell = monitors[0]
  assert.equal(dell.width, 2560)
  assert.equal(dell.height, 1440)
  assert.equal(dell.refresh, 59.95)
  assert.equal(dell.scale, 1)
  assert.deepEqual([dell.x, dell.y], [0, 0])
  const samsung = monitors[1]
  assert.equal(samsung.refresh, 30)
  assert.equal(samsung.scale, 1.5)
  assert.deepEqual([samsung.x, samsung.y], [2560, 0])
  assert.ok(samsung.modes.length > 10)
})

test("parseMonitors survives junk", () => {
  assert.deepEqual(logic.parseMonitors(""), [])
  assert.deepEqual(logic.parseMonitors("not json"), [])
  assert.deepEqual(logic.parseMonitors("{}"), [])
  assert.deepEqual(logic.parseMonitors([null, 4, {}, { name: "" }]), [])
  const one = logic.parseMonitors([{ name: "X-1", width: 800, height: 600, scale: 0, transform: 99 }])
  assert.equal(one[0].scale, 1)
  assert.equal(one[0].transform, 0)
})

test("disabled and mirrored outputs stay out of the arrangement", () => {
  const monitors = [
    display("A-1", 0, 0, 1920, 1080, 1),
    display("B-1", 0, 0, 1920, 1080, 1, { disabled: true }),
    display("C-1", 0, 0, 1920, 1080, 1, { mirrorOf: "A-1" })
  ]
  assert.deepEqual(logic.arrangeable(monitors).map((m) => m.name), ["A-1"])
  assert.deepEqual(logic.skipped(monitors).map((m) => m.name), ["B-1", "C-1"])
})

// --------------------------------------------------------------- geometry

test("logicalSize divides by scale and swaps for quarter turns", () => {
  const layout = fixtureLayout()
  assert.deepEqual(logic.logicalSize(logic.entryByName(layout, DELL)), { width: 2560, height: 1440 })
  assert.deepEqual(logic.logicalSize(logic.entryByName(layout, SAMSUNG)), { width: 2560, height: 1440 })
  assert.deepEqual(logic.logicalSize(display("R-1", 0, 0, 1920, 1080, 1, { transform: 1 })),
    { width: 1080, height: 1920 })
  assert.deepEqual(logic.logicalSize(display("R-1", 0, 0, 1920, 1080, 1, { transform: 2 })),
    { width: 1920, height: 1080 })
})

test("the fixture layout is valid as it stands", () => {
  const layout = fixtureLayout()
  assert.equal(logic.sideOf(layout, SAMSUNG, DELL), "right")
  assert.equal(logic.sideOf(layout, DELL, SAMSUNG), "left")
  assert.ok(logic.isConnected(layout))
  assert.deepEqual(logic.overlappingPairs(layout), [])
  const check = logic.validateLayout(layout)
  assert.deepEqual(check.errors, [])
  assert.deepEqual(check.warnings, [])
})

test("dragging the Samsung to the left swaps the two displays", () => {
  const next = logic.dropMonitor(fixtureLayout(), SAMSUNG, -2400, 30, 60)
  assert.deepEqual(position(next, SAMSUNG), [0, 0])
  assert.deepEqual(position(next, DELL), [2560, 0])
  assert.equal(logic.sideOf(next, SAMSUNG, DELL), "left")
})

test("dragging below or above stacks the displays", () => {
  const below = logic.dropMonitor(fixtureLayout(), SAMSUNG, 10, 1500, 60)
  assert.deepEqual(position(below, DELL), [0, 0])
  assert.deepEqual(position(below, SAMSUNG), [0, 1440])
  assert.equal(logic.sideOf(below, SAMSUNG, DELL), "below")

  const above = logic.dropMonitor(fixtureLayout(), SAMSUNG, -20, -1500, 60)
  assert.deepEqual(position(above, SAMSUNG), [0, 0])
  assert.deepEqual(position(above, DELL), [0, 1440])
})

test("a drop far from an alignment stop keeps its offset", () => {
  const next = logic.dropMonitor(fixtureLayout(), SAMSUNG, 2600, 400, 40)
  assert.deepEqual(position(next, DELL), [0, 0])
  assert.deepEqual(position(next, SAMSUNG), [2560, 400])
})

test("a drop on top of another display is pushed to the nearest edge", () => {
  const next = logic.dropMonitor(fixtureLayout(), SAMSUNG, 900, 100, 40)
  assert.deepEqual(logic.overlappingPairs(next), [])
  assert.ok(logic.isConnected(next))
})

test("a drop far away still ends attached, sharing enough edge", () => {
  const next = logic.dropMonitor(fixtureLayout(), SAMSUNG, 9000, 9000, 40)
  assert.ok(logic.isConnected(next))
  const dell = logic.rectOf(logic.entryByName(next, DELL))
  const samsung = logic.rectOf(logic.entryByName(next, SAMSUNG))
  const sharedX = Math.min(dell.x + dell.w, samsung.x + samsung.w) - Math.max(dell.x, samsung.x)
  const sharedY = Math.min(dell.y + dell.h, samsung.y + samsung.h) - Math.max(dell.y, samsung.y)
  assert.ok(Math.max(sharedX, sharedY) >= logic.MIN_SHARED_EDGE)
})

test("no drop ever overlaps, disconnects, or goes negative", () => {
  let seed = 12345
  function random() {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  let layout = [
    display("A-1", 0, 0, 2560, 1440, 1),
    display("B-1", 2560, 0, 3840, 2160, 1.5),
    display("C-1", 5120, 0, 1920, 1080, 1),
    display("D-1", 7040, 0, 1920, 1080, 1, { transform: 1 })
  ]
  for (let i = 0; i < 400; i++) {
    const mover = layout[Math.floor(random() * layout.length)].name
    layout = logic.dropMonitor(layout, mover, random() * 12000 - 4000, random() * 8000 - 3000, 40)
    assert.deepEqual(logic.overlappingPairs(layout), [], "overlap at step " + i)
    assert.ok(logic.isConnected(layout), "gap at step " + i)
    const bounds = logic.layoutBounds(layout)
    assert.deepEqual([bounds.x, bounds.y], [0, 0], "not normalized at step " + i)
    assert.deepEqual(logic.validateLayout(layout).errors, [], "invalid at step " + i)
  }
})

test("pulling the middle display out closes the gap it leaves", () => {
  const row = [
    display("A-1", 0, 0, 1920, 1080, 1),
    display("B-1", 1920, 0, 1920, 1080, 1),
    display("C-1", 3840, 0, 1920, 1080, 1)
  ]
  const next = logic.dropMonitor(row, "B-1", 6000, 0, 40)
  assert.deepEqual(position(next, "A-1"), [0, 0])
  assert.deepEqual(position(next, "C-1"), [1920, 0])
  assert.deepEqual(position(next, "B-1"), [3840, 0])
})

test("closeGaps leaves a connected layout alone", () => {
  const layout = fixtureLayout()
  assert.deepEqual(logic.closeGaps(layout, SAMSUNG), layout)
  assert.deepEqual(logic.closeGaps([], "X"), [])
  const gap = [display("A-1", 0, 0, 1920, 1080, 1), display("B-1", 2500, 300, 1920, 1080, 1)]
  const closed = logic.closeGaps(gap, "A-1")
  assert.deepEqual(position(closed, "A-1"), [0, 0])
  assert.deepEqual(position(closed, "B-1"), [1920, 300])
})

test("dropMonitor ignores unknown displays and does not mutate its input", () => {
  const layout = fixtureLayout()
  const copy = JSON.stringify(layout)
  const same = logic.dropMonitor(layout, "NOPE-9", 50, 50, 40)
  assert.deepEqual(position(same, SAMSUNG), [2560, 0])
  logic.dropMonitor(layout, SAMSUNG, -3000, 0, 40)
  assert.equal(JSON.stringify(layout), copy)
})

test("a lone display sits at 0x0", () => {
  const next = logic.dropMonitor([display("A-1", 300, 200, 1920, 1080, 1)], "A-1", 700, 900, 40)
  assert.deepEqual(position(next, "A-1"), [0, 0])
})

test("placeOnSide puts a display on each side", () => {
  const small = [display("A-1", 0, 0, 2560, 1440, 1), display("B-1", 2560, 0, 1920, 1080, 1)]
  const left = logic.placeOnSide(small, "B-1", "A-1", "left")
  assert.deepEqual(position(left, "B-1"), [0, 0])
  assert.deepEqual(position(left, "A-1"), [1920, 0])

  const right = logic.placeOnSide(left, "B-1", "A-1", "right", "end")
  assert.deepEqual(position(right, "A-1"), [0, 0])
  assert.deepEqual(position(right, "B-1"), [2560, 360])

  const above = logic.placeOnSide(small, "B-1", "A-1", "above", "center")
  assert.deepEqual(position(above, "B-1"), [320, 0])
  assert.deepEqual(position(above, "A-1"), [0, 1080])

  const below = logic.placeOnSide(small, "B-1", "A-1", "below")
  assert.deepEqual(position(below, "B-1"), [0, 1440])
  assert.equal(logic.sideOf(below, "B-1", "A-1"), "below")
})

test("placeOnSide rejects nonsense and avoids a taken slot", () => {
  const three = [
    display("A-1", 0, 0, 1920, 1080, 1),
    display("B-1", 1920, 0, 1920, 1080, 1),
    display("C-1", 3840, 0, 1920, 1080, 1)
  ]
  assert.deepEqual(position(logic.placeOnSide(three, "C-1", "C-1", "left"), "C-1"), [3840, 0])
  assert.deepEqual(position(logic.placeOnSide(three, "C-1", "A-1", "sideways"), "C-1"), [3840, 0])
  // B already sits right of A, so C cannot take that exact spot.
  const next = logic.placeOnSide(three, "C-1", "A-1", "right")
  assert.deepEqual(logic.overlappingPairs(next), [])
  assert.ok(logic.isConnected(next))
})

// ------------------------------------------------------------------ edits

test("changing scale re-seats the neighbors", () => {
  const next = logic.setScale(fixtureLayout(), DELL, 2)
  assert.equal(logic.entryByName(next, DELL).scale, 2)
  assert.deepEqual(logic.logicalSize(logic.entryByName(next, DELL)), { width: 1280, height: 720 })
  assert.deepEqual(position(next, DELL), [0, 0])
  assert.deepEqual(position(next, SAMSUNG), [1280, 0])
  assert.deepEqual(logic.validateLayout(next).errors, [])
})

test("changing the scale of the right display leaves the left one alone", () => {
  const next = logic.setScale(fixtureLayout(), SAMSUNG, 2)
  assert.deepEqual(position(next, DELL), [0, 0])
  assert.deepEqual(position(next, SAMSUNG), [2560, 0])
  assert.deepEqual(logic.logicalSize(logic.entryByName(next, SAMSUNG)), { width: 1920, height: 1080 })
})

test("setScale snaps to a clean scale and ignores bad input", () => {
  const next = logic.setScale(fixtureLayout(), DELL, 1.5)
  assert.equal(logic.entryByName(next, DELL).scale, 1.6)
  assert.equal(logic.entryByName(logic.setScale(fixtureLayout(), DELL, -1), DELL).scale, 1)
  assert.equal(logic.entryByName(logic.setScale(fixtureLayout(), DELL, "big"), DELL).scale, 1)
})

test("reflow keeps bottom and center alignment", () => {
  const bottom = [display("A-1", 0, 0, 2560, 1440, 1), display("B-1", 2560, 360, 1920, 1080, 1)]
  const grown = logic.setScale(bottom, "A-1", 2)
  // A is now 1280x720; B stays bottom-aligned, so A drops to y 360.
  const a = logic.rectOf(logic.entryByName(grown, "A-1"))
  const b = logic.rectOf(logic.entryByName(grown, "B-1"))
  assert.equal(a.y + a.h, b.y + b.h)
  assert.equal(b.x, a.x + a.w)

  const centered = [display("A-1", 0, 0, 2560, 1440, 1), display("B-1", 2560, 180, 1920, 1080, 1)]
  const next = logic.setScale(centered, "B-1", 2)
  const a2 = logic.rectOf(logic.entryByName(next, "A-1"))
  const b2 = logic.rectOf(logic.entryByName(next, "B-1"))
  assert.equal(b2.y - a2.y, (a2.h - b2.h) / 2)
})

test("reflow never leaves an overlap when a display grows", () => {
  const layout = [
    display("A-1", 0, 0, 3840, 2160, 2),
    display("B-1", 1920, 0, 1920, 1080, 1),
    display("C-1", 0, 1080, 1920, 1080, 1)
  ]
  assert.deepEqual(logic.validateLayout(layout).errors, [])
  const next = logic.setScale(layout, "A-1", 1)
  assert.deepEqual(logic.overlappingPairs(next), [])
  assert.ok(logic.isConnected(next))
})

test("setResolution keeps the nearest refresh rate and a clean scale", () => {
  const next = logic.setResolution(fixtureLayout(), SAMSUNG, 1920, 1080)
  const samsung = logic.entryByName(next, SAMSUNG)
  assert.equal(samsung.width, 1920)
  assert.equal(samsung.height, 1080)
  assert.equal(samsung.refresh, 30)
  assert.equal(samsung.scale, 1.5)
  assert.deepEqual(logic.logicalSize(samsung), { width: 1280, height: 720 })
  assert.deepEqual(logic.validateLayout(next).errors, [])

  const qhd = logic.entryByName(logic.setResolution(fixtureLayout(), SAMSUNG, 2560, 1440), SAMSUNG)
  assert.equal(qhd.refresh, 59.95)
  assert.equal(qhd.scale, 1.6)
})

test("setResolution and setRefresh refuse modes the display lacks", () => {
  const layout = fixtureLayout()
  assert.equal(logic.entryByName(logic.setResolution(layout, DELL, 3840, 2160), DELL).width, 2560)
  assert.equal(logic.entryByName(logic.setRefresh(layout, DELL, 144), DELL).refresh, 59.95)
  assert.equal(logic.entryByName(logic.setRefresh(layout, SAMSUNG, 29.97), SAMSUNG).refresh, 29.97)
})

test("layoutChanges lists what moved", () => {
  const original = fixtureLayout()
  assert.equal(logic.hasChanges(original, fixtureLayout()), false)
  const next = logic.setScale(logic.dropMonitor(original, SAMSUNG, -3000, 0, 40), SAMSUNG, 2)
  const changes = logic.layoutChanges(original, next)
  assert.deepEqual(changes.map((c) => c.name).sort(), [DELL, SAMSUNG].sort())
  const samsung = changes.find((c) => c.name === SAMSUNG).changes.join(" | ")
  assert.match(samsung, /scale 1\.5 → 2/)
  assert.match(samsung, /position 2560x0 → 0x0/)
})

// ------------------------------------------------------------- validation

test("validateLayout blocks overlaps, bad scales, bad modes, bad names", () => {
  const overlap = [display("A-1", 0, 0, 1920, 1080, 1), display("B-1", 100, 100, 1920, 1080, 1)]
  assert.deepEqual(logic.validateLayout(overlap).errors.map((e) => e.code), ["overlap"])

  const scale = [display("A-1", 0, 0, 2560, 1440, 1.5)]
  assert.deepEqual(logic.validateLayout(scale).errors.map((e) => e.code), ["bad-scale"])

  const mode = [display("A-1", 0, 0, 2560, 1440, 1, { refresh: 144 })]
  assert.deepEqual(logic.validateLayout(mode).errors.map((e) => e.code), ["bad-mode"])

  const name = [display("A-1\"}) os.exit()", 0, 0, 1920, 1080, 1)]
  assert.deepEqual(logic.validateLayout(name).errors.map((e) => e.code), ["bad-name"])

  assert.deepEqual(logic.validateLayout([]).errors.map((e) => e.code), ["empty"])
})

test("a gap is a warning, not an error", () => {
  const gap = [display("A-1", 0, 0, 1920, 1080, 1), display("B-1", 2500, 0, 1920, 1080, 1)]
  const check = logic.validateLayout(gap)
  assert.equal(check.ok, true)
  assert.deepEqual(check.warnings.map((w) => w.code), ["gap"])
})

// -------------------------------------------------------------------- Lua

test("luaQuote escapes quotes and backslashes and refuses control characters", () => {
  assert.equal(logic.luaQuote("DP-2"), "\"DP-2\"")
  assert.equal(logic.luaQuote("a\"b\\c"), "\"a\\\"b\\\\c\"")
  assert.equal(logic.luaQuote("line\nbreak"), null)
  assert.equal(logic.luaQuote("nul\u0000"), null)
})

test("findMonitorSelectors reads the user's own rules", () => {
  assert.deepEqual(logic.findMonitorSelectors(monitorsLua), [
    "desc:Dell Inc. DELL U2719D",
    "desc:Samsung Electric Company U28H75x",
    "eDP-1"
  ])
})

test("findMonitorSelectors skips comments, the catch-all, and the managed block", () => {
  const lua = [
    "hl.monitor({ output = \"\", mode = \"preferred\", position = \"auto\", scale = 1 })",
    "-- hl.monitor({ output = \"DP-9\", mode = \"preferred\" })",
    "--[[ hl.monitor({ output = \"DP-8\" }) ]]",
    "local name = \"eDP-1\" -- hl.monitor({ output = \"DP-7\" })",
    "hl.monitor({ output = name, scale = 2 })",
    "hl.monitor({ mode = \"preferred\", output = 'HDMI-A-2' })",
    "hl.monitor({ output = unknown_variable })",
    logic.BLOCK_BEGIN,
    "hl.monitor({ output = \"DP-1\", scale = 1 })",
    logic.BLOCK_END
  ].join("\n")
  assert.deepEqual(logic.findMonitorSelectors(lua), ["eDP-1", "HDMI-A-2"])
})

test("findMonitorRules pairs each selector with its written mode", () => {
  assert.deepEqual(logic.findMonitorRules(monitorsLua), [
    { selector: "desc:Dell Inc. DELL U2719D", mode: "2560x1440@60" },
    { selector: "desc:Samsung Electric Company U28H75x", mode: "3840x2160@30" },
    { selector: "eDP-1", mode: "preferred" }
  ])
  const lua = [
    "local m = \"1920x1080@60\"",
    "hl.monitor({ mode = '2560x1440@144.00Hz', output = 'DP-3' })",
    "hl.monitor({ output = \"DP-4\", mode = m })",
    "hl.monitor({ output = \"DP-5\" })",
    logic.BLOCK_BEGIN,
    "hl.monitor({ output = \"DP-3\", mode = \"2560x1440@59.95\" })",
    logic.BLOCK_END
  ].join("\n")
  assert.deepEqual(logic.findMonitorRules(lua), [
    { selector: "DP-3", mode: "2560x1440@144.00Hz" },
    { selector: "DP-4", mode: "" },
    { selector: "DP-5", mode: "" }
  ])
})

test("configuredRefresh keeps the written rate within 0.1 Hz", () => {
  const dell = logic.entryByName(fixtureLayout(), DELL)
  assert.equal(dell.refresh, 59.95)
  assert.equal(logic.CONFIGURED_REFRESH_TOLERANCE, 0.1)
  const rule = (mode, selector) => [{ selector: selector || "desc:Dell Inc. DELL U2719D", mode: mode }]
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@60")), "60")
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@60.00Hz")), "60.00")
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@59.85")), "59.85")
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@59.95")), "59.95")
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@60", "DP-2")), "60")
  // Too far off, another resolution, not this display, or not a mode.
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@60.1")), "")
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@75")), "")
  assert.equal(logic.configuredRefresh(dell, rule("1920x1080@60")), "")
  assert.equal(logic.configuredRefresh(dell, rule("2560x1440@60", "desc:Samsung")), "")
  assert.equal(logic.configuredRefresh(dell, rule("preferred")), "")
  assert.equal(logic.configuredRefresh(dell, rule("")), "")
  assert.equal(logic.configuredRefresh(dell, []), "")
  assert.equal(logic.configuredRefresh(dell, undefined), "")
  // The last matching rule wins, as in Hyprland.
  assert.equal(logic.configuredRefresh(dell, [
    { selector: "DP-2", mode: "2560x1440@60" },
    { selector: "desc:Dell Inc.", mode: "2560x1440@59.9" }
  ]), "59.9")
})

test("the configured @60 is kept in apply, block, and saved file", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const plan = logic.buildPlan({
    snapshot: snapshot, layout: logic.setScale(logic.arrangeable(snapshot), DELL, 2),
    fileText: monitorsLua, fileState: "present"
  })
  assert.equal(plan.ok, true)
  for (const text of [plan.applyLua, plan.block, plan.fileText]) {
    assert.match(text, /output = "desc:Dell Inc\. DELL U2719D", mode = "2560x1440@60", /)
    assert.doesNotMatch(text.replace(monitorsLua, ""), /@59\.95/)
  }
  // The fallback revert restores what Hyprland reported, not the config.
  assert.match(plan.revertLua, /output = "DP-2", mode = "2560x1440@59\.95"/)
  // Hyprland will still report 59.95 for @60. The check after Apply
  // compares against the chosen mode, so the refresh is not a difference.
  const dellDiff = logic.layoutDiff([logic.entryByName(plan.layout, DELL)], snapshot)
  assert.deepEqual(dellDiff, ["DP-2 scale 1, wanted 2"])
})

test("a new refresh rate is written as chosen, not as configured", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const layout = logic.setResolution(logic.arrangeable(snapshot), SAMSUNG, 1920, 1080)
  const refreshed = logic.setRefresh(layout, SAMSUNG, 60)
  const plan = logic.buildPlan({ snapshot: snapshot, layout: refreshed, fileText: monitorsLua, fileState: "present" })
  assert.match(plan.applyLua, /U28H75x", mode = "1920x1080@60"/)
  const slow = logic.setRefresh(layout, SAMSUNG, 24)
  const slowPlan = logic.buildPlan({ snapshot: snapshot, layout: slow, fileText: monitorsLua, fileState: "present" })
  assert.match(slowPlan.applyLua, /U28H75x", mode = "1920x1080@24"/)
})

test("without a config the reported refresh is written", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const plan = logic.buildPlan({ snapshot: snapshot, layout: logic.arrangeable(snapshot), fileText: "", fileState: "missing" })
  assert.match(plan.applyLua, /mode = "2560x1440@59\.95"/)
})

test("ruleLua only writes a refresh text that is a number", () => {
  const dell = logic.entryByName(fixtureLayout(), DELL)
  assert.match(logic.ruleLua(dell, "DP-2", "60"), /mode = "2560x1440@60"/)
  assert.match(logic.ruleLua(dell, "DP-2", "60\"), os.exit() --"), /mode = "2560x1440@59\.95"/)
  assert.match(logic.ruleLua(dell, "DP-2", ""), /mode = "2560x1440@59\.95"/)
})

test("selectorFor prefers the user's selector, then description, then connector", () => {
  const layout = fixtureLayout()
  const dell = logic.entryByName(layout, DELL)
  const known = logic.findMonitorSelectors(monitorsLua)
  assert.equal(logic.selectorFor(dell, layout, known), "desc:Dell Inc. DELL U2719D")
  assert.equal(logic.selectorFor(dell, layout, []), "desc:Dell Inc. DELL U2719D TESTDELL01")
  assert.equal(logic.selectorFor(dell, layout, ["DP-2"]), "DP-2")
  assert.equal(logic.selectorFor(dell, layout, ["DP-2", "desc:Dell Inc."]), "desc:Dell Inc.")
})

test("twin displays fall back to connector names", () => {
  const twins = [
    display("DP-1", 0, 0, 1920, 1080, 1, { description: "Acme Twin" }),
    display("DP-2", 1920, 0, 1920, 1080, 1, { description: "Acme Twin" })
  ]
  assert.equal(logic.selectorFor(twins[0], twins, []), "DP-1")
  assert.equal(logic.selectorFor(twins[1], twins, ["desc:Acme"]), "DP-2")
  const blank = display("DP-3", 0, 0, 1920, 1080, 1, { description: "" })
  assert.equal(logic.selectorFor(blank, [blank], []), "DP-3")
})

test("ruleLua writes the Omarchy monitor format", () => {
  const layout = fixtureLayout()
  assert.equal(logic.ruleLua(logic.entryByName(layout, SAMSUNG), "desc:Samsung Electric Company U28H75x"),
    "hl.monitor({ output = \"desc:Samsung Electric Company U28H75x\", mode = \"3840x2160@30\", "
    + "position = \"2560x0\", scale = 1.5 })")
  assert.equal(logic.ruleLua(display("R-1", 0, 0, 1920, 1080, 1, { transform: 3 }), "R-1"),
    "hl.monitor({ output = \"R-1\", mode = \"1920x1080@60\", position = \"0x0\", scale = 1, transform = 3 })")
  assert.equal(logic.ruleLua(display("R-1", 0, 0, 1920, 1080, 1), "bad\nname"), null)
})

test("revertLua restores the snapshot by connector name", () => {
  const lua = logic.revertLua(logic.parseMonitors(monitorsJson))
  assert.equal(lua, [
    "hl.monitor({ output = \"DP-2\", mode = \"2560x1440@59.95\", position = \"0x0\", scale = 1 })",
    "hl.monitor({ output = \"HDMI-A-1\", mode = \"3840x2160@30\", position = \"2560x0\", scale = 1.5 })"
  ].join("\n"))
  assert.equal(logic.revertLua([display("bad name", 0, 0, 1920, 1080, 1)]), null)
})

// ------------------------------------------------------ monitors.lua block

test("the managed block is appended and everything else is untouched", () => {
  const block = logic.managedBlock(fixtureLayout(), logic.findMonitorSelectors(monitorsLua))
  const result = logic.upsertManagedBlock(monitorsLua, block)
  assert.equal(result.ok, true)
  assert.equal(result.replaced, false)
  assert.ok(result.text.startsWith(monitorsLua))
  assert.ok(result.text.endsWith(logic.BLOCK_END + "\n"))
  assert.equal(result.text, monitorsLua + "\n" + block + "\n")
})

test("saving twice replaces the block instead of stacking it", () => {
  const known = logic.findMonitorSelectors(monitorsLua)
  const first = logic.upsertManagedBlock(monitorsLua, logic.managedBlock(fixtureLayout(), known))
  const moved = logic.dropMonitor(fixtureLayout(), SAMSUNG, -3000, 0, 40)
  const second = logic.upsertManagedBlock(first.text, logic.managedBlock(moved, known))
  assert.equal(second.ok, true)
  assert.equal(second.replaced, true)
  assert.equal(second.text.split(logic.BLOCK_BEGIN).length, 2)
  assert.equal(second.text.split(logic.BLOCK_END).length, 2)
  assert.ok(second.text.startsWith(monitorsLua))
  assert.match(second.text, /output = "desc:Dell Inc\. DELL U2719D", mode = "2560x1440@59\.95", position = "2560x0"/)

  const again = logic.upsertManagedBlock(second.text, logic.managedBlock(moved, known))
  assert.equal(again.text, second.text)
})

test("the block moves to the end so it wins over rules added after it", () => {
  const block = logic.managedBlock(fixtureLayout(), [])
  const text = "local a = 1\n\n" + block + "\n\nhl.monitor({ output = \"DP-9\", scale = 1 })\n"
  const result = logic.upsertManagedBlock(text, block)
  assert.equal(result.text,
    "local a = 1\n\nhl.monitor({ output = \"DP-9\", scale = 1 })\n\n" + block + "\n")
})

test("removeManagedBlock restores the original file", () => {
  const block = logic.managedBlock(fixtureLayout(), [])
  const saved = logic.upsertManagedBlock(monitorsLua, block)
  const removed = logic.removeManagedBlock(saved.text)
  assert.equal(removed.ok, true)
  assert.equal(removed.found, true)
  assert.equal(removed.text, monitorsLua)
  assert.deepEqual(logic.removeManagedBlock(monitorsLua), { ok: true, found: false, text: monitorsLua })
})

test("removing the block keeps the user's own blank lines", () => {
  const block = logic.managedBlock(fixtureLayout(), [])
  const before = "local a = 1\n\n\n"
  const after = "\n\nhl.monitor({ output = \"DP-9\", scale = 1 })\n"
  const removed = logic.removeManagedBlock(before + block + "\n" + after)
  assert.equal(removed.text, "local a = 1\n\n" + after)
  // Only the one separator line upsert adds goes with the block.
  const saved = logic.upsertManagedBlock("a\n\n\n", block)
  assert.equal(saved.text, "a\n\n\n\n" + block + "\n")
  assert.equal(logic.removeManagedBlock(saved.text).text, "a\n\n\n")
})

test("damaged markers are refused, not guessed at", () => {
  const cases = [
    monitorsLua + logic.BLOCK_BEGIN + "\n",
    monitorsLua + logic.BLOCK_END + "\n",
    logic.BLOCK_END + "\n" + logic.BLOCK_BEGIN + "\n",
    logic.BLOCK_BEGIN + "\n" + logic.BLOCK_END + "\n" + logic.BLOCK_BEGIN + "\n" + logic.BLOCK_END + "\n"
  ]
  for (const text of cases) {
    const result = logic.upsertManagedBlock(text, "x")
    assert.equal(result.ok, false)
    assert.equal(result.text, text)
    assert.match(result.error, /markers/)
  }
})

test("an empty or missing file becomes just the block", () => {
  const block = logic.managedBlock(fixtureLayout(), [])
  assert.equal(logic.upsertManagedBlock("", block).text, block + "\n")
  assert.equal(logic.upsertManagedBlock("local a = 1", block).text, "local a = 1\n\n" + block + "\n")
})

test("the saved file is valid Lua", (t) => {
  if (spawnSync("luac", ["-v"]).error) return t.skip("luac not installed")
  const dir = tempDir(t)
  const moved = logic.setScale(logic.dropMonitor(fixtureLayout(), SAMSUNG, 0, 3000, 40), DELL, 2)
  const plan = logic.buildPlan({
    snapshot: logic.parseMonitors(monitorsJson), layout: moved,
    fileText: monitorsLua, fileState: "present"
  })
  const files = { "saved.lua": plan.fileText, "apply.lua": plan.applyLua, "revert.lua": plan.revertLua }
  for (const name of Object.keys(files)) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, files[name])
    // -p parses only. Nothing is executed.
    const result = spawnSync("luac", ["-p", file], { encoding: "utf8" })
    assert.equal(result.status, 0, name + ": " + result.stderr)
  }
})

// ------------------------------------------------------------------- plan

test("buildPlan for an untouched layout changes nothing", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const plan = logic.buildPlan({
    snapshot: snapshot, layout: logic.arrangeable(snapshot), fileText: monitorsLua, fileState: "present"
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.canPersist, true)
  assert.match(logic.planPreview(plan, "/x/monitors.lua"), /CHANGES\n {2}none/)
})

test("buildPlan produces apply, revert, and file text for a swap", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const plan = logic.buildPlan({
    snapshot: snapshot,
    layout: logic.dropMonitor(logic.arrangeable(snapshot), SAMSUNG, -3000, 0, 40),
    fileText: monitorsLua, fileState: "present"
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.applyLua, [
    // The config says @60 for the 59.95 Hz panel; that is what gets written.
    "hl.monitor({ output = \"desc:Dell Inc. DELL U2719D\", mode = \"2560x1440@60\", position = \"2560x0\", scale = 1 })",
    "hl.monitor({ output = \"desc:Samsung Electric Company U28H75x\", mode = \"3840x2160@30\", position = \"0x0\", scale = 1.5 })"
  ].join("\n"))
  assert.equal(plan.revertLua, logic.revertLua(snapshot))
  assert.ok(plan.fileText.startsWith(monitorsLua))
  assert.ok(plan.fileText.includes(plan.applyLua))
  assert.equal(plan.fileOriginal, monitorsLua)

  const preview = logic.planPreview(plan, "/home/x/.config/hypr/monitors.lua")
  assert.match(preview, /APPLY \(hyprctl eval, live only\)/)
  assert.match(preview, /REVERT \(after 15s without Keep\)\n {2}hyprctl reload/)
  assert.match(preview, /KEEP \(appended to \/home\/x\/\.config\/hypr\/monitors\.lua\)/)
})

test("buildPlan blocks an invalid layout and emits no Lua", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const layout = logic.arrangeable(snapshot)
  layout[1].x = 100
  const plan = logic.buildPlan({ snapshot: snapshot, layout: layout, fileText: monitorsLua, fileState: "present" })
  assert.equal(plan.ok, false)
  assert.equal(plan.applyLua, "")
  assert.equal(plan.fileText, "")
  assert.equal(plan.canPersist, false)
  assert.match(logic.planPreview(plan), /BLOCKED/)
})

test("buildPlan will not save a file too large to pass as an argument", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const big = monitorsLua + "-- " + "x".repeat(logic.MAX_ARG_BYTES) + "\n"
  const plan = logic.buildPlan({ snapshot: snapshot, layout: logic.arrangeable(snapshot), fileText: big, fileState: "present" })
  assert.equal(plan.ok, true)
  assert.equal(plan.canPersist, false)
  assert.deepEqual(plan.warnings.map((w) => w.code), ["file-too-large"])
  assert.ok(logic.MAX_ARG_BYTES < 128 * 1024)
})

test("utf8Length counts bytes, not characters", () => {
  assert.equal(logic.utf8Length("abc"), 3)
  assert.equal(logic.utf8Length("×"), 2)
  assert.equal(logic.utf8Length("→"), 3)
  assert.equal(logic.utf8Length("😀"), 4)
  assert.equal(logic.utf8Length(""), 0)
})

test("buildPlan still applies live when the file cannot be saved", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const layout = logic.arrangeable(snapshot)
  const unreadable = logic.buildPlan({ snapshot: snapshot, layout: layout, fileText: "", fileState: "unreadable" })
  assert.equal(unreadable.ok, true)
  assert.equal(unreadable.canPersist, false)
  assert.deepEqual(unreadable.warnings.map((w) => w.code), ["file-unreadable"])

  const damaged = logic.buildPlan({
    snapshot: snapshot, layout: layout, fileText: logic.BLOCK_BEGIN + "\n", fileState: "present"
  })
  assert.equal(damaged.ok, true)
  assert.equal(damaged.canPersist, false)
  assert.deepEqual(damaged.warnings.map((w) => w.code), ["file-markers"])

  const missing = logic.buildPlan({ snapshot: snapshot, layout: layout, fileText: "", fileState: "missing" })
  assert.equal(missing.canPersist, true)
  assert.equal(missing.fileText, missing.block + "\n")
})

// -------------------------------------------------------------- countdown

test("the confirmation counts down from 15 and expires", () => {
  assert.equal(logic.CONFIRM_SECONDS, 15)
  assert.deepEqual(logic.confirmState(1000, 1000), { remaining: 15, expired: false, progress: 0 })
  assert.equal(logic.confirmState(1000, 1001).remaining, 15)
  assert.equal(logic.confirmState(1000, 2000).remaining, 14)
  assert.equal(logic.confirmState(1000, 15999).remaining, 1)
  assert.equal(logic.confirmState(1000, 15999).expired, false)
  assert.deepEqual(logic.confirmState(1000, 16000), { remaining: 0, expired: true, progress: 1 })
  assert.equal(logic.confirmState(1000, 99999).expired, true)
  // A clock that jumps backwards must not extend the window past 15s.
  assert.equal(logic.confirmState(5000, 1000).remaining, 15)
  assert.equal(logic.confirmState(0, 3000, 5).remaining, 2)
})

test("the watchdog outlasts the countdown", () => {
  assert.equal(logic.watchdogSeconds(), logic.CONFIRM_SECONDS + logic.WATCHDOG_GRACE_SECONDS)
  assert.ok(logic.watchdogSeconds() > logic.CONFIRM_SECONDS)
  assert.equal(logic.watchdogSeconds(1), 1 + logic.WATCHDOG_GRACE_SECONDS)
})

// ---------------------------------------------------------------- scripts

test("revertLua is only the fallback revert", () => {
  // Reload is primary everywhere: the panel and the watchdog both try it
  // before the connector-name rules.
  for (const script of [logic.REVERT_SCRIPT, logic.WATCHDOG_SCRIPT]) {
    assert.ok(script.indexOf("\"$hyprctl\" reload") < script.indexOf("\"$hyprctl\" eval \"$lua\""))
  }
})

test("watchdog reloads when nobody keeps", (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const token = path.join(dir, "run", "token")
  const lua = logic.revertLua(logic.parseMonitors(monitorsJson))
  const started = Date.now()
  const result = runScript(logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog", [token, lua, "1", stub.bin])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Date.now() - started >= 900)
  assert.equal(stub.calls(), "reload\n")
  assert.match(result.stdout, /reverted by reload/)
  assert.equal(fs.existsSync(token + ".live"), false)
})

test("watchdog falls back to the snapshot rules when reload fails", (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const token = path.join(dir, "token")
  fs.writeFileSync(token + ".revert", "")
  const lua = logic.revertLua(logic.parseMonitors(monitorsJson))
  const result = runScript(logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog",
    [token, lua, "30", stub.bin], { STUB_RELOAD_EXIT: "1" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(stub.calls(), "reload\neval " + lua + "\n")
  assert.equal(fs.existsSync(token + ".revert"), false)
})

test("a reload that prints an error counts as failed", (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const result = runScript(logic.REVERT_SCRIPT, "omarchy-displays-revert", ["hl.monitor({})", stub.bin],
    { STUB_RELOAD_OUT: "error: config has errors" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(stub.calls(), "reload\neval hl.monitor({})\n")
  assert.match(result.stdout, /reverted by eval/)
})

test("revert exits non-zero when both reload and eval fail", (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const result = runScript(logic.REVERT_SCRIPT, "omarchy-displays-revert", ["hl.monitor({})", stub.bin],
    { STUB_RELOAD_EXIT: "1", STUB_EVAL_EXIT: "0", STUB_EVAL_OUT: "error: bad rule" })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /eval failed \(0\): error: bad rule/)
})

test("watchdog stands down on keep or done", (t) => {
  for (const suffix of [".keep", ".done"]) {
    const dir = tempDir(t)
    const stub = stubHyprctl(dir)
    const token = path.join(dir, "token")
    fs.writeFileSync(token + suffix, "")
    const result = runScript(logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog", [token, "hl.monitor({})", "5", stub.bin])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(stub.calls(), "", suffix)
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("token")), [], suffix)
  }
})

test("watchdog reverts at once on revert", (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const token = path.join(dir, "token")
  fs.writeFileSync(token + ".revert", "")
  const started = Date.now()
  const result = runScript(logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog", [token, "hl.monitor({})", "30", stub.bin])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Date.now() - started < 2000)
  assert.equal(stub.calls(), "reload\n")
  assert.equal(fs.existsSync(token + ".revert"), false)
})

test("watchdog passes hostile Lua through as data", (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const token = path.join(dir, "token")
  const marker = path.join(dir, "pwned")
  fs.writeFileSync(token + ".revert", "")
  const lua = "\"; touch " + marker + "; $(touch " + marker + ") `touch " + marker + "`"
  runScript(logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog", [token, lua, "30", stub.bin], { STUB_RELOAD_EXIT: "1" })
  assert.equal(fs.existsSync(marker), false)
  assert.equal(stub.calls(), "reload\neval " + lua + "\n")
})

test("scan counts an armed watchdog and clears what dead ones left", async (t) => {
  const dir = tempDir(t)
  const stub = stubHyprctl(dir)
  const runDir = path.join(dir, "run")
  fs.mkdirSync(runDir)
  // Leftovers: a .live for a dead pid, one for a live pid that is not a
  // watchdog, a bad pid, and stray tokens with no watchdog.
  fs.writeFileSync(path.join(runDir, "1.live"), "999999999\n")
  fs.writeFileSync(path.join(runDir, "2.live"), process.pid + "\n")
  fs.writeFileSync(path.join(runDir, "3.live"), "nope\n")
  fs.writeFileSync(path.join(runDir, "4.revert"), "")
  fs.writeFileSync(path.join(runDir, "5.keep"), "")
  fs.writeFileSync(path.join(runDir, "6.done"), "")

  assert.equal(runScript(logic.SCAN_SCRIPT, "omarchy-displays-scan", [runDir]).stdout, "0\n")
  assert.deepEqual(fs.readdirSync(runDir), [])

  const token = path.join(runDir, "7")
  const { spawn } = require("child_process")
  const child = spawn("sh", ["-c", logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog", token, "x", "30", stub.bin])
  const exited = new Promise((resolve) => child.on("exit", resolve))
  t.after(() => child.kill())
  for (let i = 0; i < 50 && !fs.existsSync(token + ".live"); i++) await new Promise((r) => setTimeout(r, 20))
  fs.writeFileSync(token + ".keep", "")
  // A .keep that belongs to the armed watchdog is left for it.
  const armed = runScript(logic.SCAN_SCRIPT, "omarchy-displays-scan", [runDir])
  assert.equal(armed.stdout, "1\n")
  await exited
  assert.equal(stub.calls(), "")
  assert.equal(runScript(logic.SCAN_SCRIPT, "omarchy-displays-scan", [runDir]).stdout, "0\n")
  assert.equal(runScript(logic.SCAN_SCRIPT, "omarchy-displays-scan", [path.join(dir, "none")]).stdout, "0\n")
})

test("run wrapper reports output and exit code together", () => {
  const ok = logic.parseRunOutput(runScript(logic.RUN_SCRIPT, "run", ["sh", "-c", "echo ok"]).stdout)
  assert.deepEqual(ok, { code: 0, output: "ok" })
  const bad = logic.parseRunOutput(runScript(logic.RUN_SCRIPT, "run", ["sh", "-c", "echo boom >&2; exit 3"]).stdout)
  assert.deepEqual(bad, { code: 3, output: "boom" })
  const quiet = logic.parseRunOutput(runScript(logic.RUN_SCRIPT, "run", ["true"]).stdout)
  assert.deepEqual(quiet, { code: 0, output: "" })
  assert.deepEqual(logic.parseRunOutput("half"), { code: -1, output: "half" })
})

test("commandError finds hyprctl errors even on exit 0", () => {
  assert.equal(logic.commandError({ code: 0, output: "ok" }), "")
  assert.equal(logic.commandError({ code: 0, output: "" }), "")
  assert.equal(logic.commandError({ code: 0, output: "ok\nerror: invalid mode 9x9@1" }), "error: invalid mode 9x9@1")
  assert.equal(logic.commandError({ code: 1, output: "Couldn't connect" }), "Couldn't connect (exit 1)")
  assert.equal(logic.commandError({ code: 2, output: "" }), "Exit 2")
  assert.equal(logic.commandError({ code: -1, output: "" }), "The command did not finish")
})

test("layoutDiff says what Hyprland shows differently", () => {
  const snapshot = logic.parseMonitors(monitorsJson)
  const expected = logic.arrangeable(snapshot)
  assert.deepEqual(logic.layoutDiff(expected, snapshot), [])
  const moved = JSON.parse(monitorsJson)
  moved[1].x = 0
  moved[1].y = 1440
  moved[1].scale = 2
  moved[1].refreshRate = 29.97
  assert.deepEqual(logic.layoutDiff(expected, logic.parseMonitors(moved)), [
    "HDMI-A-1 mode 3840x2160@29.97, wanted 3840x2160@30",
    "HDMI-A-1 scale 2, wanted 1.5",
    "HDMI-A-1 at 0x1440, wanted 2560x0"
  ])
  moved[0].disabled = true
  assert.equal(logic.layoutDiff(expected, logic.parseMonitors(moved))[0], "DP-2 is not active")
  assert.deepEqual(logic.layoutDiff(expected, []), ["DP-2 is not active", "HDMI-A-1 is not active"])
})

test("the settle wait is about 5 seconds", () => {
  assert.equal(logic.SETTLE_TIMEOUT_MS, 5000)
  assert.ok(logic.SETTLE_POLL_MS > 0 && logic.SETTLE_POLL_MS < 1000)
})

test("the window rule extra is valid Lua and matches the window", (t) => {
  const extra = path.join(__dirname, "..", "extra", "omarchy-displays-window.lua")
  const qml = fs.readFileSync(path.join(__dirname, "..", "plugin", "sd.displays", "run", "Displays.qml"), "utf8")
  const lua = fs.readFileSync(extra, "utf8")
  assert.match(qml, /FloatingWindow \{\s*id: window\s*title: "Displays"/)
  assert.match(lua, /class == "org\.quickshell" and title == "Displays"/)
  assert.match(lua, /title = "\^Displays\$"/)
  if (spawnSync("luac", ["-v"]).error) return t.skip("luac not installed")
  const result = spawnSync("luac", ["-p", extra], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
})

test("touch script creates the token and its folder", (t) => {
  const dir = tempDir(t)
  const token = path.join(dir, "deep", "er", "token.keep")
  assert.equal(runScript(logic.TOUCH_SCRIPT, "touch", [token]).status, 0)
  assert.equal(fs.readFileSync(token, "utf8"), "")
})

test("read script reports present, missing, and unreadable", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  fs.writeFileSync(file, monitorsLua)
  const present = logic.parseReadOutput(runScript(logic.READ_SCRIPT, "read", [file]).stdout)
  assert.deepEqual(present, { state: "present", text: monitorsLua })

  const missing = logic.parseReadOutput(runScript(logic.READ_SCRIPT, "read", [path.join(dir, "no.lua")]).stdout)
  assert.deepEqual(missing, { state: "missing", text: "" })

  const folder = logic.parseReadOutput(runScript(logic.READ_SCRIPT, "read", [dir]).stdout)
  assert.deepEqual(folder, { state: "unreadable", text: "" })
  assert.deepEqual(logic.parseReadOutput(""), { state: "unreadable", text: "" })

  fs.writeFileSync(file, "")
  assert.deepEqual(logic.parseReadOutput(runScript(logic.READ_SCRIPT, "read", [file]).stdout),
    { state: "present", text: "" })
})

function swapPlan(fileText, fileState) {
  const snapshot = logic.parseMonitors(monitorsJson)
  return logic.buildPlan({
    snapshot: snapshot,
    layout: logic.dropMonitor(logic.arrangeable(snapshot), SAMSUNG, -3000, 0, 40),
    fileText: fileText, fileState: fileState
  })
}

test("persist writes the file and keeps a backup", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  fs.writeFileSync(file, monitorsLua)
  const plan = swapPlan(monitorsLua, "present")
  const result = runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(plan, file, "1700000000"))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(file, "utf8"), plan.fileText)
  assert.equal(fs.readFileSync(file + ".bak.1700000000", "utf8"), monitorsLua)
  assert.deepEqual(fs.readdirSync(dir).sort(), ["monitors.lua", "monitors.lua.bak.1700000000"])
  assert.equal(logic.persistError(result.status), "")
})

test("persist keeps only the newest backups", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  fs.writeFileSync(file, monitorsLua)
  for (const stamp of ["100", "200", "300", "400", "500", "600", "9"]) fs.writeFileSync(file + ".bak." + stamp, stamp)
  fs.writeFileSync(file + ".bak.manual", "mine")
  const plan = swapPlan(monitorsLua, "present")
  const result = runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(plan, file, "700"))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "monitors.lua", "monitors.lua.bak.300", "monitors.lua.bak.400", "monitors.lua.bak.500",
    "monitors.lua.bak.600", "monitors.lua.bak.700", "monitors.lua.bak.manual"
  ])
  assert.equal(fs.readFileSync(file + ".bak.700", "utf8"), monitorsLua)
  assert.equal(logic.BACKUPS_KEPT, 5)
})

test("two saves in the same second keep both backups", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  fs.writeFileSync(file, monitorsLua)
  const first = swapPlan(monitorsLua, "present")
  assert.equal(runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(first, file, "50")).status, 0)
  const second = logic.buildPlan({
    snapshot: logic.parseMonitors(monitorsJson), layout: fixtureLayout(),
    fileText: first.fileText, fileState: "present"
  })
  assert.equal(runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(second, file, "50")).status, 0)
  assert.equal(fs.readFileSync(file + ".bak.50", "utf8"), monitorsLua)
  assert.equal(fs.readFileSync(file + ".bak.51", "utf8"), first.fileText)
  assert.equal(fs.readFileSync(file, "utf8"), second.fileText)
})

test("persist exit codes arrive through the run wrapper", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  fs.writeFileSync(file, "changed\n")
  const plan = swapPlan(monitorsLua, "present")
  const run = logic.parseRunOutput(runScript(logic.RUN_SCRIPT, "run",
    ["sh", "-c", logic.PERSIST_SCRIPT, "persist"].concat(logic.persistArgs(plan, file, "1"))).stdout)
  assert.equal(run.code, 3)
  assert.match(logic.persistError(run.code), /changed since it was read/)
})

test("persist refuses when the file changed after it was read", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  const plan = swapPlan(monitorsLua, "present")
  const edited = monitorsLua + "-- edited by hand meanwhile\n"
  fs.writeFileSync(file, edited)
  const result = runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(plan, file, "1"))
  assert.equal(result.status, 3)
  assert.equal(fs.readFileSync(file, "utf8"), edited)
  assert.deepEqual(fs.readdirSync(dir), ["monitors.lua"])
  assert.match(logic.persistError(3), /changed since it was read/)
})

test("persist refuses when a file appeared or vanished", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  fs.writeFileSync(file, "local a = 1\n")
  const missing = swapPlan("", "missing")
  assert.equal(runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(missing, file, "1")).status, 3)
  assert.equal(fs.readFileSync(file, "utf8"), "local a = 1\n")

  fs.rmSync(file)
  const present = swapPlan(monitorsLua, "present")
  assert.equal(runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(present, file, "1")).status, 3)
  assert.equal(fs.existsSync(file), false)
})

test("persist creates a missing file without a backup", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "hypr", "monitors.lua")
  const plan = swapPlan("", "missing")
  const result = runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(plan, file, "1"))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(file, "utf8"), plan.block + "\n")
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["monitors.lua"])
})

test("persist writes through a symlink and leaves it a symlink", (t) => {
  const dir = tempDir(t)
  const real = path.join(dir, "dotfiles", "monitors.lua")
  const link = path.join(dir, "monitors.lua")
  fs.mkdirSync(path.dirname(real))
  fs.writeFileSync(real, monitorsLua)
  fs.symlinkSync(real, link)
  const plan = swapPlan(monitorsLua, "present")
  const result = runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(plan, link, "7"))
  assert.equal(result.status, 0, result.stderr)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readFileSync(real, "utf8"), plan.fileText)
  assert.equal(fs.readFileSync(real + ".bak.7", "utf8"), monitorsLua)
})

test("persist keeps shell metacharacters in the file as plain text", (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, "monitors.lua")
  const marker = path.join(dir, "pwned")
  const nasty = "-- $(touch " + marker + ") `touch " + marker + "` \"; touch " + marker + "\n%s %d \\n\n"
  fs.writeFileSync(file, nasty)
  const plan = swapPlan(nasty, "present")
  const result = runScript(logic.PERSIST_SCRIPT, "persist", logic.persistArgs(plan, file, "1"))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(marker), false)
  assert.ok(fs.readFileSync(file, "utf8").startsWith(nasty))
})

test("backupStamp is whole seconds", () => {
  assert.equal(logic.backupStamp(1700000000999), "1700000000")
})

// ---------------------------------------------------------------- payload

test("parsePayload reads dryRun and an absolute monitorsFile", () => {
  const fallback = "/home/x/.config/hypr/monitors.lua"
  assert.deepEqual(logic.parsePayload("{}", fallback), { dryRun: false, monitorsFile: fallback })
  assert.deepEqual(logic.parsePayload("", fallback), { dryRun: false, monitorsFile: fallback })
  assert.deepEqual(logic.parsePayload("not json", fallback), { dryRun: false, monitorsFile: fallback })
  assert.deepEqual(logic.parsePayload("{\"dryRun\":true}", fallback), { dryRun: true, monitorsFile: fallback })
  assert.deepEqual(logic.parsePayload("{\"monitorsFile\":\"/tmp/try.lua\"}", fallback),
    { dryRun: false, monitorsFile: "/tmp/try.lua" })
  for (const bad of ["relative.lua", "/tmp/../etc/x.lua", "/tmp/a\nb.lua", 5, null])
    assert.equal(logic.parsePayload(JSON.stringify({ monitorsFile: bad }), fallback).monitorsFile, fallback)
})

// ----------------------------------------------------------------- canvas

test("canvas transform fits the layout and round-trips positions", () => {
  const layout = fixtureLayout()
  const view = logic.canvasTransform(layout, 800, 300, 20)
  assert.ok(view.k > 0)
  for (const entry of layout) {
    const box = logic.toCanvas(logic.rectOf(entry), view)
    assert.ok(box.x >= 20 && box.x + box.w <= 780, entry.name + " x")
    assert.ok(box.y >= 20 && box.y + box.h <= 280, entry.name + " y")
    assert.deepEqual(logic.toLogical(box.x, box.y, view), { x: entry.x, y: entry.y })
  }
  // Room is left to drag one display to any side of the rest.
  const bounds = logic.layoutBounds(layout)
  assert.ok((bounds.w + 2560) * view.k <= 760 + 1e-6)
})

test("canvas transform copes with nothing to show", () => {
  assert.deepEqual(logic.canvasTransform([], 800, 300, 20), { k: 1, originX: 20, originY: 20 })
  assert.deepEqual(logic.toLogical(20, 20, { k: 0, originX: 20, originY: 20 }), { x: 0, y: 0 })
})
