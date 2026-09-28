// Shared display-arrangement logic. run/Displays.qml imports this; Node tests
// require the same file. Parsing, geometry, snapping, rule generation, the
// managed monitors.lua block, and the keep/revert countdown live here so
// node --test can drive them without QML and without touching Hyprland.

var PLUGIN_ID = "io.github.stevederico.omarchy-displays"

var CONFIRM_SECONDS = 15
// The detached watchdog outlives the countdown by this much, so the panel's
// own revert normally wins and the watchdog is only the dead-man's switch.
var WATCHDOG_GRACE_SECONDS = 2
var WATCHDOG_TICKS_PER_SECOND = 5

var BLOCK_BEGIN = "-- omarchy-displays: begin"
var BLOCK_END = "-- omarchy-displays: end"

var SCALE_PRESETS = [1, 1.25, 1.5, 1.6, 2, 3, 4]

// Two displays must share at least this much edge (logical px) to count as
// neighbors after a drop, so the pointer always has room to cross.
var MIN_SHARED_EDGE = 64

var SAFE_NAME = /^[A-Za-z0-9._-]+$/

// The scripts below take monitors.lua and the Lua rules as argv strings.
// Linux caps one argv string at MAX_ARG_STRLEN (32 pages, 128 KiB) and fails
// the exec with E2BIG past it. Stay well under so Keep refuses up front
// instead of failing halfway.
var MAX_ARG_BYTES = 120 * 1024

// Backups kept next to monitors.lua. Older ones are removed on each save.
var BACKUPS_KEPT = 5

// How long to wait for `hyprctl monitors` to show a revert or apply.
var SETTLE_TIMEOUT_MS = 5000
var SETTLE_POLL_MS = 250

// ---------------------------------------------------------------- numbers

function roundTo(value, places) {
  var factor = Math.pow(10, places)
  return Math.round(Number(value) * factor) / factor
}

function formatRefresh(refresh) {
  return String(roundTo(refresh, 2))
}

function formatScale(scale) {
  return String(roundTo(scale, 6))
}

function gcd(a, b) {
  while (b) {
    var remainder = a % b
    a = b
    b = remainder
  }
  return a
}

// Hyprland only accepts scales where the mode divides into whole logical
// pixels (in 1/120 steps), so clean scales are divisors of gcd(w*120, h*120).
// Rounds the requested scale up to the nearest clean value, like
// omarchy-hyprland-monitor-scaling. Returns 0 for unusable input.
function cleanScale(scale, width, height) {
  var requested = Number(scale)
  var modeWidth = Number(width)
  var modeHeight = Number(height)
  if (!isFinite(requested) || !isFinite(modeWidth) || !isFinite(modeHeight)
      || requested <= 0 || modeWidth <= 0 || modeHeight <= 0) return 0

  var divisor = gcd(Math.round(modeWidth * 120), Math.round(modeHeight * 120))
  var units = Math.round(requested * 120)
  if (units < 1) units = 1
  if (units > divisor) units = divisor
  while (divisor % units !== 0) units++
  return roundTo(units / 120, 6)
}

function sameScale(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005
}

// ------------------------------------------------------------------ modes

function parseMode(text) {
  var match = /^\s*(\d+)x(\d+)@(\d+(?:\.\d+)?)(?:Hz)?\s*$/.exec(String(text || ""))
  if (!match) return null
  var width = parseInt(match[1], 10)
  var height = parseInt(match[2], 10)
  var refresh = roundTo(parseFloat(match[3]), 2)
  if (!(width > 0) || !(height > 0) || !(refresh > 0)) return null
  return { width: width, height: height, refresh: refresh, key: modeKey(width, height, refresh) }
}

function modeKey(width, height, refresh) {
  return width + "x" + height + "@" + formatRefresh(refresh)
}

// Deduped, in hyprctl order (preferred mode first).
function parseModes(list) {
  var out = []
  var seen = {}
  if (!Array.isArray(list)) return out
  for (var i = 0; i < list.length; i++) {
    var mode = parseMode(list[i])
    if (!mode || seen[mode.key]) continue
    seen[mode.key] = true
    out.push(mode)
  }
  return out
}

// Unique resolutions, largest first, each with its refresh rates high to low.
function resolutionOptions(entry) {
  var modes = (entry && entry.modes) || []
  var byKey = {}
  var out = []
  for (var i = 0; i < modes.length; i++) {
    var key = modes[i].width + "x" + modes[i].height
    if (!byKey[key]) {
      byKey[key] = { key: key, label: modes[i].width + " × " + modes[i].height,
                     width: modes[i].width, height: modes[i].height, refreshRates: [] }
      out.push(byKey[key])
    }
    byKey[key].refreshRates.push(modes[i].refresh)
  }
  for (var j = 0; j < out.length; j++)
    out[j].refreshRates.sort(function(a, b) { return b - a })
  out.sort(function(a, b) {
    return (b.width * b.height - a.width * a.height) || (b.width - a.width)
  })
  return out
}

function refreshOptions(entry, width, height) {
  var options = resolutionOptions(entry)
  for (var i = 0; i < options.length; i++) {
    if (options[i].width === Number(width) && options[i].height === Number(height))
      return options[i].refreshRates.slice()
  }
  return []
}

function hasMode(entry, width, height, refresh) {
  var modes = (entry && entry.modes) || []
  var key = modeKey(width, height, refresh)
  for (var i = 0; i < modes.length; i++) if (modes[i].key === key) return true
  return false
}

function nearestRefresh(rates, wanted) {
  var best = null
  var bestDistance = Infinity
  for (var i = 0; i < rates.length; i++) {
    var distance = Math.abs(rates[i] - wanted)
    if (distance < bestDistance || (distance === bestDistance && rates[i] > best)) {
      best = rates[i]
      bestDistance = distance
    }
  }
  return best
}

// Clean scale presets for the entry's current mode, ascending. The current
// scale is always present so the active pill can light up.
function scaleOptions(entry) {
  var out = []
  var seen = {}
  function add(value) {
    var key = formatScale(value)
    if (!(value > 0) || seen[key]) return
    seen[key] = true
    out.push({ value: value, label: formatScale(roundTo(value, 2)) + "x" })
  }
  if (!entry) return out
  for (var i = 0; i < SCALE_PRESETS.length; i++)
    add(cleanScale(SCALE_PRESETS[i], entry.width, entry.height))
  add(roundTo(entry.scale, 6))
  out.sort(function(a, b) { return a.value - b.value })
  return out
}

// --------------------------------------------------------------- monitors

function parseMonitors(raw) {
  var data = raw
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw)
    } catch (e) {
      data = []
    }
  }
  if (!Array.isArray(data)) return []

  var out = []
  for (var i = 0; i < data.length; i++) {
    var m = data[i]
    if (!m || typeof m !== "object") continue
    var name = String(m.name || "")
    if (!name) continue

    var modes = parseModes(m.availableModes)
    var width = Math.round(Number(m.width) || 0)
    var height = Math.round(Number(m.height) || 0)
    var liveRefresh = Number(m.refreshRate) || 0
    var refresh = roundTo(liveRefresh, 2)
    // Snap the live rate (59.95100) onto the advertised mode (59.95Hz).
    var listed = nearestRefresh(refreshOptions({ modes: modes }, width, height), liveRefresh)
    if (listed !== null && Math.abs(listed - liveRefresh) < 0.5) refresh = listed

    var scale = Number(m.scale)
    if (!isFinite(scale) || scale <= 0) scale = 1
    var transform = Math.round(Number(m.transform) || 0)
    if (transform < 0 || transform > 7) transform = 0

    out.push({
      id: Number(m.id) || 0,
      name: name,
      description: String(m.description || ""),
      make: String(m.make || ""),
      model: String(m.model || ""),
      serial: String(m.serial || ""),
      width: width,
      height: height,
      refresh: refresh,
      x: Math.round(Number(m.x) || 0),
      y: Math.round(Number(m.y) || 0),
      scale: roundTo(scale, 6),
      transform: transform,
      disabled: m.disabled === true,
      mirrorOf: String(m.mirrorOf || "none"),
      focused: m.focused === true,
      modes: modes
    })
  }

  out.sort(function(a, b) {
    return (a.x - b.x) || (a.y - b.y) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
  return out
}

// Displays that take part in the arrangement. Disabled and mirrored outputs
// have no place on the desktop, so they are left exactly as they are.
function isArrangeable(entry) {
  return !!entry && !entry.disabled && (entry.mirrorOf === "none" || entry.mirrorOf === "")
    && entry.width > 0 && entry.height > 0
}

function arrangeable(monitors) {
  var out = []
  for (var i = 0; i < (monitors || []).length; i++)
    if (isArrangeable(monitors[i])) out.push(cloneEntry(monitors[i]))
  return out
}

function skipped(monitors) {
  var out = []
  for (var i = 0; i < (monitors || []).length; i++)
    if (!isArrangeable(monitors[i])) out.push(cloneEntry(monitors[i]))
  return out
}

function cloneEntry(entry) {
  var copy = {}
  for (var key in entry) copy[key] = entry[key]
  return copy
}

function cloneLayout(layout) {
  var out = []
  for (var i = 0; i < (layout || []).length; i++) out.push(cloneEntry(layout[i]))
  return out
}

function indexOfName(layout, name) {
  for (var i = 0; i < (layout || []).length; i++)
    if (layout[i].name === name) return i
  return -1
}

function entryByName(layout, name) {
  var index = indexOfName(layout, name)
  return index < 0 ? null : layout[index]
}

function displayLabel(entry) {
  if (!entry) return ""
  return entry.model || entry.description || entry.name
}

function modeLabel(entry) {
  if (!entry) return ""
  return entry.width + " × " + entry.height + " @ " + formatRefresh(entry.refresh) + " Hz"
}

// --------------------------------------------------------------- geometry

// Size on the desktop in logical pixels: mode divided by scale, swapped for
// the quarter-turn transforms (1, 3, 5, 7).
function logicalSize(entry) {
  var scale = Number(entry.scale) > 0 ? Number(entry.scale) : 1
  var width = Math.round(entry.width / scale)
  var height = Math.round(entry.height / scale)
  if (entry.transform % 2 === 1) return { width: height, height: width }
  return { width: width, height: height }
}

function rectOf(entry) {
  var size = logicalSize(entry)
  return { x: entry.x, y: entry.y, w: size.width, h: size.height }
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function sharedLength(aStart, aLength, bStart, bLength) {
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart)
}

// Which side of `anchor` the rect sits flush against: "right", "left",
// "below", "above", or "" when they do not share an edge.
function sideOfRect(rect, anchor) {
  if (sharedLength(rect.y, rect.h, anchor.y, anchor.h) > 0) {
    if (rect.x === anchor.x + anchor.w) return "right"
    if (rect.x + rect.w === anchor.x) return "left"
  }
  if (sharedLength(rect.x, rect.w, anchor.x, anchor.w) > 0) {
    if (rect.y === anchor.y + anchor.h) return "below"
    if (rect.y + rect.h === anchor.y) return "above"
  }
  return ""
}

function sideOf(layout, name, anchorName) {
  var entry = entryByName(layout, name)
  var anchor = entryByName(layout, anchorName)
  if (!entry || !anchor || name === anchorName) return ""
  return sideOfRect(rectOf(entry), rectOf(anchor))
}

function layoutBounds(layout) {
  if (!layout || layout.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (var i = 0; i < layout.length; i++) {
    var r = rectOf(layout[i])
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Shift the whole arrangement so its top-left corner is 0x0.
function normalizeLayout(layout) {
  var out = cloneLayout(layout)
  var bounds = layoutBounds(out)
  for (var i = 0; i < out.length; i++) {
    out[i].x = Math.round(out[i].x - bounds.x)
    out[i].y = Math.round(out[i].y - bounds.y)
  }
  return out
}

function overlappingPairs(layout) {
  var pairs = []
  for (var i = 0; i < layout.length; i++)
    for (var j = i + 1; j < layout.length; j++)
      if (rectsOverlap(rectOf(layout[i]), rectOf(layout[j])))
        pairs.push([layout[i].name, layout[j].name])
  return pairs
}

function isConnected(layout) {
  if (!layout || layout.length <= 1) return true
  var seen = {}
  var queue = [0]
  seen[0] = true
  var count = 1
  while (queue.length) {
    var current = rectOf(layout[queue.shift()])
    for (var i = 0; i < layout.length; i++) {
      if (seen[i]) continue
      if (sideOfRect(rectOf(layout[i]), current) === "") continue
      seen[i] = true
      count++
      queue.push(i)
    }
  }
  return count === layout.length
}

// Slide along a neighbor's edge: stay within reach of it, then snap to its
// start, end, or center when the drop lands close enough.
function alignAlong(position, length, anchorStart, anchorLength, threshold) {
  var shared = Math.min(MIN_SHARED_EDGE, length, anchorLength)
  var low = anchorStart - length + shared
  var high = anchorStart + anchorLength - shared
  var value = Math.max(low, Math.min(high, position))
  var stops = [anchorStart, anchorStart + anchorLength - length,
               anchorStart + (anchorLength - length) / 2]
  var best = value
  var bestDistance = Number(threshold) >= 0 ? Number(threshold) : 0
  for (var i = 0; i < stops.length; i++) {
    var distance = Math.abs(value - stops[i])
    if (distance <= bestDistance) {
      best = stops[i]
      bestDistance = distance
    }
  }
  return Math.round(best)
}

function sidePosition(size, anchor, side, along) {
  if (side === "right") return { x: anchor.x + anchor.w, y: along }
  if (side === "left") return { x: anchor.x - size.w, y: along }
  if (side === "below") return { x: along, y: anchor.y + anchor.h }
  return { x: along, y: anchor.y - size.h }
}

var SIDES = ["right", "left", "below", "above"]

// macOS-style drop: the display lands flush against whichever free edge of
// another display is closest to where it was let go. Never overlaps.
function nearestSlot(size, proposed, others, threshold) {
  if (!others || others.length === 0) return { x: 0, y: 0, side: "", anchor: -1 }

  var best = null
  var bestDistance = Infinity
  for (var i = 0; i < others.length; i++) {
    var anchor = others[i]
    for (var s = 0; s < SIDES.length; s++) {
      var side = SIDES[s]
      var horizontal = side === "right" || side === "left"
      var along = horizontal
        ? alignAlong(proposed.y, size.h, anchor.y, anchor.h, threshold)
        : alignAlong(proposed.x, size.w, anchor.x, anchor.w, threshold)
      var spot = sidePosition(size, anchor, side, along)
      var rect = { x: spot.x, y: spot.y, w: size.w, h: size.h }

      var blocked = false
      for (var j = 0; j < others.length; j++) {
        if (rectsOverlap(rect, others[j])) {
          blocked = true
          break
        }
      }
      if (blocked) continue

      var dx = spot.x - proposed.x
      var dy = spot.y - proposed.y
      var distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestDistance = distance
        best = { x: spot.x, y: spot.y, side: side, anchor: i }
      }
    }
  }
  return best
}

function otherRects(layout, name) {
  var out = []
  for (var i = 0; i < layout.length; i++)
    if (layout[i].name !== name) out.push(rectOf(layout[i]))
  return out
}

function rectDistance(a, b) {
  var dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w))
  var dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
  return dx * dx + dy * dy
}

// Pulling a display out of the middle strands the ones it was holding
// together. Starting from `anchorName`, walk outward and re-seat every
// stranded display against the group, nearest first, until all of them
// touch again. A layout that is already connected comes back unchanged.
function closeGaps(layout, anchorName) {
  var out = cloneLayout(layout)
  if (out.length <= 1) return out

  var rects = []
  for (var i = 0; i < out.length; i++) rects.push(rectOf(out[i]))
  var inGroup = {}
  var groupSize = 0
  function join(index) {
    inGroup[index] = true
    groupSize++
  }
  function grow() {
    var grew = true
    while (grew) {
      grew = false
      for (var candidate = 0; candidate < out.length; candidate++) {
        if (inGroup[candidate]) continue
        var touches = false
        var clashes = false
        for (var member = 0; member < out.length; member++) {
          if (!inGroup[member]) continue
          if (rectsOverlap(rects[candidate], rects[member])) clashes = true
          else if (sideOfRect(rects[candidate], rects[member]) !== "") touches = true
        }
        if (touches && !clashes) {
          join(candidate)
          grew = true
        }
      }
    }
  }

  join(Math.max(0, indexOfName(out, anchorName)))
  grow()
  while (groupSize < out.length) {
    var group = []
    for (var g = 0; g < out.length; g++) if (inGroup[g]) group.push(rects[g])

    var nearest = -1
    var nearestDistance = Infinity
    for (var o = 0; o < out.length; o++) {
      if (inGroup[o]) continue
      for (var m = 0; m < group.length; m++) {
        var distance = rectDistance(rects[o], group[m])
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = o
        }
      }
    }

    var slot = nearestSlot({ w: rects[nearest].w, h: rects[nearest].h },
                           { x: rects[nearest].x, y: rects[nearest].y }, group, 0)
    if (slot) {
      rects[nearest].x = slot.x
      rects[nearest].y = slot.y
      out[nearest].x = slot.x
      out[nearest].y = slot.y
    }
    join(nearest)
    grow()
  }
  return out
}

// Drop `name` at a proposed logical position. Returns a new, normalized
// layout. Unknown names and blocked drops leave the layout unchanged.
function dropMonitor(layout, name, proposedX, proposedY, threshold) {
  var out = cloneLayout(layout)
  var index = indexOfName(out, name)
  if (index < 0) return normalizeLayout(out)

  var size = logicalSize(out[index])
  var slot = nearestSlot({ w: size.width, h: size.height },
                         { x: Number(proposedX) || 0, y: Number(proposedY) || 0 },
                         otherRects(out, name), threshold)
  if (slot) {
    out[index].x = slot.x
    out[index].y = slot.y
  }
  return normalizeLayout(closeGaps(out, name))
}

// Put `name` on one side of `anchorName`. align: "start" (tops or lefts
// line up), "center", or "end". Falls back to the nearest free slot when
// another display already sits there.
function placeOnSide(layout, name, anchorName, side, align) {
  var out = cloneLayout(layout)
  var index = indexOfName(out, name)
  var anchorEntry = entryByName(out, anchorName)
  if (index < 0 || !anchorEntry || name === anchorName || SIDES.indexOf(side) < 0)
    return normalizeLayout(out)

  var size = logicalSize(out[index])
  var box = { w: size.width, h: size.height }
  var anchor = rectOf(anchorEntry)
  var horizontal = side === "right" || side === "left"
  var start = horizontal ? anchor.y : anchor.x
  var room = horizontal ? anchor.h - box.h : anchor.w - box.w
  var along = start
  if (align === "center") along = start + Math.round(room / 2)
  else if (align === "end") along = start + room

  var spot = sidePosition(box, anchor, side, along)
  var others = otherRects(out, name)
  var rect = { x: spot.x, y: spot.y, w: box.w, h: box.h }
  for (var i = 0; i < others.length; i++) {
    if (!rectsOverlap(rect, others[i])) continue
    var slot = nearestSlot(box, spot, others, 0)
    if (slot) spot = slot
    break
  }
  out[index].x = spot.x
  out[index].y = spot.y
  return normalizeLayout(closeGaps(out, name))
}

// How `child` hangs off `parent`: which side, and how it lines up along the
// shared edge. null when they do not touch.
function relationBetween(parent, child) {
  var side = sideOfRect(child, parent)
  if (!side) return null
  var horizontal = side === "right" || side === "left"
  var offset = horizontal ? child.y - parent.y : child.x - parent.x
  var room = horizontal ? parent.h - child.h : parent.w - child.w
  var align = "offset"
  if (offset === 0) align = "start"
  else if (offset === room) align = "end"
  else if (Math.abs(offset * 2 - room) <= 1) align = "center"
  return { side: side, align: align, offset: offset }
}

function placeRelative(parent, size, relation) {
  var horizontal = relation.side === "right" || relation.side === "left"
  var start = horizontal ? parent.y : parent.x
  var parentLength = horizontal ? parent.h : parent.w
  var length = horizontal ? size.h : size.w
  var along
  if (relation.align === "start") along = start
  else if (relation.align === "end") along = start + parentLength - length
  else if (relation.align === "center") along = start + Math.round((parentLength - length) / 2)
  else along = alignAlong(start + relation.offset, length, start, parentLength, 0)
  return sidePosition(size, parent, relation.side, along)
}

// A scale or resolution change resizes a display. Rebuild positions so
// every display keeps the neighbor, side, and alignment it had before.
// `before` and `after` hold the same displays in the same order.
function reflow(before, after) {
  var out = cloneLayout(after)
  if (out.length === 0) return out
  if (out.length === 1) {
    out[0].x = 0
    out[0].y = 0
    return out
  }

  var oldRects = []
  for (var i = 0; i < out.length; i++) {
    var previous = entryByName(before, out[i].name) || out[i]
    oldRects.push(rectOf(previous))
  }

  var placed = {}
  var order = []
  function sizeAt(index) {
    var size = logicalSize(out[index])
    return { w: size.width, h: size.height }
  }
  function settle(index, x, y) {
    var size = sizeAt(index)
    placed[index] = { x: x, y: y, w: size.w, h: size.h }
    order.push(index)
  }

  for (var root = 0; root < out.length; root++) {
    if (placed[root]) continue
    // Each island keeps its own anchor where it was.
    settle(root, oldRects[root].x, oldRects[root].y)
    var queue = [root]
    while (queue.length) {
      var parent = queue.shift()
      for (var child = 0; child < out.length; child++) {
        if (placed[child]) continue
        var relation = relationBetween(oldRects[parent], oldRects[child])
        if (!relation) continue
        var spot = placeRelative(placed[parent], sizeAt(child), relation)
        settle(child, spot.x, spot.y)
        queue.push(child)
      }
    }
  }

  // A grown display can push into one it was not attached to. Re-seat
  // anything that now overlaps a display placed before it.
  var settled = []
  for (var k = 0; k < order.length; k++) {
    var rect = placed[order[k]]
    var clash = false
    for (var p = 0; p < settled.length; p++) {
      if (rectsOverlap(rect, settled[p])) {
        clash = true
        break
      }
    }
    if (clash) {
      var slot = nearestSlot({ w: rect.w, h: rect.h }, { x: rect.x, y: rect.y }, settled, 0)
      if (slot) {
        rect.x = slot.x
        rect.y = slot.y
      }
    }
    settled.push(rect)
    out[order[k]].x = rect.x
    out[order[k]].y = rect.y
  }

  return normalizeLayout(out)
}

// ------------------------------------------------------------------ edits

function setScale(layout, name, scale) {
  var out = cloneLayout(layout)
  var index = indexOfName(out, name)
  if (index < 0) return out
  var clean = cleanScale(scale, out[index].width, out[index].height)
  if (!(clean > 0)) return out
  out[index].scale = clean
  return reflow(layout, out)
}

// Pick a resolution. Keeps the refresh rate closest to the current one and
// re-cleans the scale, since a clean scale depends on the mode.
function setResolution(layout, name, width, height) {
  var out = cloneLayout(layout)
  var index = indexOfName(out, name)
  if (index < 0) return out
  var rates = refreshOptions(out[index], width, height)
  if (rates.length === 0) return out
  out[index].width = Number(width)
  out[index].height = Number(height)
  out[index].refresh = nearestRefresh(rates, out[index].refresh)
  var clean = cleanScale(out[index].scale, out[index].width, out[index].height)
  if (clean > 0) out[index].scale = clean
  return reflow(layout, out)
}

function setRefresh(layout, name, refresh) {
  var out = cloneLayout(layout)
  var index = indexOfName(out, name)
  if (index < 0) return out
  var wanted = roundTo(refresh, 2)
  if (!hasMode(out[index], out[index].width, out[index].height, wanted)) return out
  out[index].refresh = wanted
  return out
}

function entryChanges(before, after) {
  var changes = []
  if (!before) return ["new display"]
  if (before.width !== after.width || before.height !== after.height
      || before.refresh !== after.refresh)
    changes.push("mode " + modeKey(before.width, before.height, before.refresh)
                 + " → " + modeKey(after.width, after.height, after.refresh))
  if (!sameScale(before.scale, after.scale))
    changes.push("scale " + formatScale(before.scale) + " → " + formatScale(after.scale))
  if (before.x !== after.x || before.y !== after.y)
    changes.push("position " + before.x + "x" + before.y + " → " + after.x + "x" + after.y)
  return changes
}

function layoutChanges(original, edited) {
  var out = []
  for (var i = 0; i < (edited || []).length; i++) {
    var changes = entryChanges(entryByName(original, edited[i].name), edited[i])
    if (changes.length) out.push({ name: edited[i].name, changes: changes })
  }
  return out
}

function hasChanges(original, edited) {
  return layoutChanges(original, edited).length > 0
}

// ------------------------------------------------------------- validation

// Errors block Apply. Warnings are shown but do not.
function validateLayout(layout) {
  var errors = []
  var warnings = []
  if (!layout || layout.length === 0) {
    errors.push({ code: "empty", message: "No active displays to arrange" })
    return { ok: false, errors: errors, warnings: warnings }
  }

  var names = {}
  for (var i = 0; i < layout.length; i++) {
    var entry = layout[i]
    if (!SAFE_NAME.test(entry.name))
      errors.push({ code: "bad-name", message: "Unsafe output name: " + JSON.stringify(entry.name) })
    if (names[entry.name])
      errors.push({ code: "duplicate", message: "Duplicate output: " + entry.name })
    names[entry.name] = true

    if (entry.modes && entry.modes.length > 0
        && !hasMode(entry, entry.width, entry.height, entry.refresh))
      errors.push({ code: "bad-mode", message: entry.name + " does not offer "
                    + modeKey(entry.width, entry.height, entry.refresh) })

    var clean = cleanScale(entry.scale, entry.width, entry.height)
    if (!(clean > 0) || !sameScale(clean, entry.scale))
      errors.push({ code: "bad-scale", message: entry.name + " scale " + formatScale(entry.scale)
                    + " does not divide " + entry.width + "x" + entry.height + " cleanly" })

    if (entry.x < 0 || entry.y < 0 || entry.x !== Math.round(entry.x) || entry.y !== Math.round(entry.y))
      errors.push({ code: "bad-position", message: entry.name + " has an invalid position" })
  }

  var pairs = overlappingPairs(layout)
  for (var p = 0; p < pairs.length; p++)
    errors.push({ code: "overlap", message: pairs[p][0] + " overlaps " + pairs[p][1] })

  if (!isConnected(layout))
    warnings.push({ code: "gap", message: "Some displays do not touch. The pointer cannot cross the gap" })

  return { ok: errors.length === 0, errors: errors, warnings: warnings }
}

// -------------------------------------------------------------------- Lua

// Double-quoted Lua string literal. Returns null for text that has no
// business in a config file (control characters), so callers can refuse.
function luaQuote(text) {
  var s = String(text)
  if (/[\u0000-\u001f\u007f]/.test(s)) return null
  return "\"" + s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\""
}

function stripLuaComments(text) {
  var source = String(text || "").replace(/--\[\[[\s\S]*?\]\]/g, "")
  var lines = source.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var quote = ""
    for (var c = 0; c < line.length; c++) {
      var ch = line.charAt(c)
      if (quote) {
        if (ch === "\\") c++
        else if (ch === quote) quote = ""
      } else if (ch === "\"" || ch === "'") {
        quote = ch
      } else if (ch === "-" && line.charAt(c + 1) === "-") {
        lines[i] = line.substring(0, c)
        break
      }
    }
  }
  return lines.join("\n")
}

function unquoteLua(literal) {
  return literal.substring(1, literal.length - 1).replace(/\\(.)/g, "$1")
}

var LUA_STRING = "\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'"

// The user's own hl.monitor rules, outside the managed block, in file order:
// [{ selector, mode }]. Resolves `local left = "desc:..."` style variables.
// mode is the literal mode string, or "" when it is not a plain string.
// The catch-all (output = "") is left out.
function findMonitorRules(luaText) {
  var source = stripLuaComments(removeManagedBlock(luaText).text)
  var locals = {}
  var assign = new RegExp("(?:^|[\\s;])local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(" + LUA_STRING + ")", "g")
  var match
  while ((match = assign.exec(source)) !== null) locals[match[1]] = unquoteLua(match[2])

  var out = []
  var table = /hl\.monitor\s*\(\s*\{([^}]*)\}/g
  var outputField = new RegExp("\\boutput\\s*=\\s*(" + LUA_STRING + "|[A-Za-z_][A-Za-z0-9_]*)")
  var modeField = new RegExp("\\bmode\\s*=\\s*(" + LUA_STRING + ")")
  while ((match = table.exec(source)) !== null) {
    var output = outputField.exec(match[1])
    if (!output) continue
    var token = output[1]
    var first = token.charAt(0)
    var selector = (first === "\"" || first === "'") ? unquoteLua(token) : locals[token]
    if (typeof selector !== "string" || selector === "") continue
    var mode = modeField.exec(match[1])
    out.push({ selector: selector, mode: mode ? unquoteLua(mode[1]) : "" })
  }
  return out
}

// Output selectors the user's own rules already use, first use first.
function findMonitorSelectors(luaText) {
  var rules = findMonitorRules(luaText)
  var out = []
  var seen = {}
  for (var i = 0; i < rules.length; i++) {
    if (seen[rules[i].selector]) continue
    seen[rules[i].selector] = true
    out.push(rules[i].selector)
  }
  return out
}

// How far a configured refresh rate may sit from the advertised mode and
// still be kept as written. Configs say @60 for a 59.95 Hz panel; Hyprland
// picks the closest mode either way.
var CONFIGURED_REFRESH_TOLERANCE = 0.1

// The refresh rate as the user's own rule for this display writes it, when
// that rule asks for the same resolution at a rate within
// CONFIGURED_REFRESH_TOLERANCE of the chosen one. The last matching rule
// wins, as in Hyprland. "" when there is nothing to keep.
function configuredRefresh(entry, configuredRules) {
  var rules = configuredRules || []
  var kept = ""
  for (var i = 0; i < rules.length; i++) {
    if (!selectorMatches(rules[i].selector, entry)) continue
    var written = /^\s*(\d+)x(\d+)@(\d+(?:\.\d+)?)(?:Hz)?\s*$/.exec(String(rules[i].mode || ""))
    if (!written) continue
    if (parseInt(written[1], 10) !== entry.width || parseInt(written[2], 10) !== entry.height) continue
    if (Math.abs(parseFloat(written[3]) - entry.refresh) > CONFIGURED_REFRESH_TOLERANCE + 1e-9) continue
    kept = written[3]
  }
  return kept
}

// Hyprland matches desc: by prefix and everything else by connector name.
function selectorMatches(selector, entry) {
  var s = String(selector || "")
  if (s === "") return false
  if (s.indexOf("desc:") === 0) {
    var wanted = s.substring(5).replace(/^\s+|\s+$/g, "")
    return wanted !== "" && entry.description.indexOf(wanted) === 0
  }
  return s === entry.name
}

function countMatches(selector, entries) {
  var count = 0
  for (var i = 0; i < entries.length; i++) if (selectorMatches(selector, entries[i])) count++
  return count
}

// Match by panel, not connector: connector names can move between boots
// (DP-1 → DP-2). Order of preference:
//   1. a selector the user's rules already use for this display
//   2. desc:<description> when it singles out one display
//   3. the connector name
function selectorFor(entry, entries, knownSelectors) {
  var all = entries || [entry]
  var known = knownSelectors || []
  var byName = ""
  for (var i = 0; i < known.length; i++) {
    if (!selectorMatches(known[i], entry) || countMatches(known[i], all) !== 1) continue
    if (luaQuote(known[i]) === null) continue
    if (known[i].indexOf("desc:") === 0) return known[i]
    if (!byName) byName = known[i]
  }
  if (byName) return byName

  var byDescription = "desc:" + entry.description
  if (entry.description !== "" && luaQuote(byDescription) !== null
      && countMatches(byDescription, all) === 1)
    return byDescription
  return entry.name
}

// refreshText, when given, is written in place of the entry's refresh rate
// (see configuredRefresh). It must be digits with an optional fraction.
function ruleLua(entry, selector, refreshText) {
  var output = luaQuote(selector)
  if (output === null) return null
  var refresh = /^\d+(?:\.\d+)?$/.test(String(refreshText || ""))
    ? String(refreshText) : formatRefresh(entry.refresh)
  var fields = [
    "output = " + output,
    "mode = \"" + entry.width + "x" + entry.height + "@" + refresh + "\"",
    "position = \"" + Math.round(entry.x) + "x" + Math.round(entry.y) + "\"",
    "scale = " + formatScale(entry.scale)
  ]
  if (entry.transform > 0) fields.push("transform = " + entry.transform)
  return "hl.monitor({ " + fields.join(", ") + " })"
}

function rulesFor(layout, knownSelectors, configuredRules) {
  var lines = []
  for (var i = 0; i < layout.length; i++) {
    var line = ruleLua(layout[i], selectorFor(layout[i], layout, knownSelectors),
                       configuredRefresh(layout[i], configuredRules))
    if (line === null) return null
    lines.push(line)
  }
  return lines
}

// Lua for `hyprctl eval`: the new arrangement, live, nothing written.
function applyLua(layout, knownSelectors, configuredRules) {
  var lines = rulesFor(layout, knownSelectors, configuredRules)
  return lines === null ? null : lines.join("\n")
}

// Fallback revert only. Rebuilds the snapshot by connector name, which
// restores mode, position, scale, and transform but not other rule options
// (vrr, bitdepth, color management). The primary revert is `hyprctl reload`.
function revertLua(snapshot) {
  var lines = []
  var entries = arrangeable(snapshot)
  for (var i = 0; i < entries.length; i++) {
    if (!SAFE_NAME.test(entries[i].name)) return null
    lines.push(ruleLua(entries[i], entries[i].name))
  }
  return lines.join("\n")
}

// ------------------------------------------------------ monitors.lua block

function managedBlock(layout, knownSelectors, configuredRules) {
  var lines = rulesFor(layout, knownSelectors, configuredRules)
  if (lines === null) return null
  return [
    BLOCK_BEGIN,
    "-- Written by the Displays plugin. Edits inside this block are overwritten.",
    "-- Delete the whole block to fall back to the rules above it."
  ].concat(lines, [BLOCK_END]).join("\n")
}

function countLines(text, marker) {
  var lines = String(text || "").split("\n")
  var hits = []
  for (var i = 0; i < lines.length; i++)
    if (lines[i].replace(/\s+$/, "") === marker) hits.push(i)
  return hits
}

// Cuts the managed block out. ok is false when the markers are damaged
// (one without the other, repeated, or out of order); the text is then
// returned untouched so nothing is guessed at.
//
// Only the block and the one blank line upsertManagedBlock puts in front of
// it are removed. The user's own blank lines, before or after, stay.
function removeManagedBlock(text) {
  var source = String(text || "")
  var begins = countLines(source, BLOCK_BEGIN)
  var ends = countLines(source, BLOCK_END)
  if (begins.length === 0 && ends.length === 0) return { ok: true, found: false, text: source }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0])
    return { ok: false, found: true, text: source,
             error: "monitors.lua has damaged omarchy-displays markers. Fix or remove them by hand" }

  var lines = source.split("\n")
  var head = lines.slice(0, begins[0])
  var tail = lines.slice(ends[0] + 1)
  if (head.length && head[head.length - 1].replace(/\s+$/, "") === "") head.pop()
  return { ok: true, found: true, text: head.concat(tail).join("\n") }
}

// Replaces the managed block, always at the end of the file: Hyprland lets
// the last matching monitor rule win, so the block has to come after the
// user's own rules. Everything outside the block is kept byte for byte.
function upsertManagedBlock(text, block) {
  var removed = removeManagedBlock(text)
  if (!removed.ok) return { ok: false, text: String(text || ""), error: removed.error }
  var base = removed.text
  if (base !== "" && base.charAt(base.length - 1) !== "\n") base += "\n"
  if (base !== "") base += "\n"
  return { ok: true, text: base + block + "\n", replaced: removed.found }
}

// ------------------------------------------------------------------- plan

// Everything Apply and Keep will do, computed up front and side-effect
// free. options: { snapshot, layout, fileText, fileState }
//   fileState: "present" | "missing" | anything else (unreadable)
function buildPlan(options) {
  var opts = options || {}
  var snapshot = opts.snapshot || []
  var layout = normalizeLayout(opts.layout || [])
  var fileText = String(opts.fileText || "")
  var fileState = String(opts.fileState || "")

  var check = validateLayout(layout)
  var errors = check.errors.slice()
  var warnings = check.warnings.slice()
  var plan = {
    ok: false, errors: errors, warnings: warnings, layout: layout,
    changes: layoutChanges(arrangeable(snapshot), layout),
    applyLua: "", revertLua: "", block: "", fileText: "", fileOriginal: fileText,
    fileState: fileState, canPersist: false
  }

  var configured = fileState === "present" ? findMonitorRules(fileText) : []
  var known = fileState === "present" ? findMonitorSelectors(fileText) : []
  var apply = applyLua(layout, known, configured)
  var revert = revertLua(snapshot)
  if (apply === null)
    errors.push({ code: "bad-selector", message: "A display description cannot be written safely" })
  if (revert === null || revert === "")
    errors.push({ code: "no-revert", message: "Cannot build a revert for the current session" })
  if (errors.length) return plan

  plan.applyLua = apply
  plan.revertLua = revert
  plan.block = managedBlock(layout, known, configured)

  if (fileState !== "present" && fileState !== "missing") {
    warnings.push({ code: "file-unreadable",
                    message: "monitors.lua cannot be read. Keep will not save" })
  } else {
    var upsert = upsertManagedBlock(fileState === "present" ? fileText : "", plan.block)
    if (!upsert.ok) {
      warnings.push({ code: "file-markers", message: upsert.error })
    } else if (utf8Length(upsert.text) > MAX_ARG_BYTES || utf8Length(fileText) > MAX_ARG_BYTES) {
      warnings.push({ code: "file-too-large",
                      message: "monitors.lua is over " + Math.floor(MAX_ARG_BYTES / 1024)
                               + " KiB. Keep will not save" })
    } else {
      plan.fileText = upsert.text
      plan.canPersist = true
    }
  }

  plan.ok = true
  return plan
}

function planPreview(plan, monitorsPath) {
  if (!plan) return ""
  var out = []
  var i
  if (plan.errors.length) {
    out.push("BLOCKED")
    for (i = 0; i < plan.errors.length; i++) out.push("  " + plan.errors[i].message)
    out.push("")
  }
  for (i = 0; i < plan.warnings.length; i++) out.push("warning: " + plan.warnings[i].message)
  if (plan.warnings.length) out.push("")

  out.push("CHANGES")
  if (plan.changes.length === 0) out.push("  none")
  for (i = 0; i < plan.changes.length; i++)
    out.push("  " + plan.changes[i].name + ": " + plan.changes[i].changes.join(", "))
  if (!plan.ok) return out.join("\n")

  out.push("", "APPLY (hyprctl eval, live only)", indent(plan.applyLua))
  out.push("", "REVERT (after " + CONFIRM_SECONDS + "s without Keep)",
           "  hyprctl reload   (monitors.lua is unchanged until Keep)",
           "  if the reload fails, hyprctl eval:", indent(indent(plan.revertLua)))
  out.push("", "KEEP (appended to " + (monitorsPath || "monitors.lua") + ")")
  out.push(plan.canPersist ? indent(plan.block) : "  not saved, see warning")
  return out.join("\n")
}

function indent(text) {
  return String(text || "").split("\n").map(function(line) { return "  " + line }).join("\n")
}

// -------------------------------------------------------------- countdown

function confirmState(startedMs, nowMs, seconds) {
  var total = (Number(seconds) > 0 ? Number(seconds) : CONFIRM_SECONDS) * 1000
  var elapsed = Math.max(0, Number(nowMs) - Number(startedMs))
  var left = Math.max(0, total - elapsed)
  return {
    remaining: Math.ceil(left / 1000),
    expired: left <= 0,
    progress: Math.min(1, elapsed / total)
  }
}

function watchdogSeconds(seconds) {
  return (Number(seconds) > 0 ? Number(seconds) : CONFIRM_SECONDS) + WATCHDOG_GRACE_SECONDS
}

// ---------------------------------------------------------------- scripts
//
// Run as: sh -c SCRIPT <label> <args...>. Every value arrives as a
// positional argument, never spliced into the script text. Each argument is
// held under MAX_ARG_BYTES (see above).

// Puts the session back. `hyprctl reload` is the primary path: monitors.lua
// is not written until Keep, so a reload restores the saved arrangement with
// everything the rules set (vrr, bitdepth, color management, and so on).
// Evaluating the snapshot rules by connector name is only the fallback for a
// reload that fails. Output containing "error" counts as a failure, so the
// fallback runs rather than trusting it. Expects $hyprctl and $lua.
var REVERT_FUNCTION = [
  "revert_now() {",
  "  out=$(\"$hyprctl\" reload 2>&1); code=$?",
  "  if [ \"$code\" -eq 0 ] && ! printf '%s\\n' \"$out\" | grep -qi error; then",
  "    echo \"reverted by reload\"; return 0",
  "  fi",
  "  echo \"reload failed ($code): $out\"",
  "  out=$(\"$hyprctl\" eval \"$lua\" 2>&1); code=$?",
  "  if [ \"$code\" -eq 0 ] && ! printf '%s\\n' \"$out\" | grep -qi error; then",
  "    echo \"reverted by eval\"; return 0",
  "  fi",
  "  echo \"eval failed ($code): $out\"",
  "  return 1",
  "}"
].join("\n")

// The panel's own revert.
//   $1 fallback Lua   $2 hyprctl binary
var REVERT_SCRIPT = [
  "lua=\"$1\"; hyprctl=\"${2:-hyprctl}\"",
  REVERT_FUNCTION,
  "revert_now"
].join("\n")

// Dead-man's switch. Started before the layout is applied and detached
// from the shell, so the revert still happens if the new layout takes the
// shell, the panel, or the screen it is on down with it.
//
// Token files, all $1 plus a suffix:
//   .live    written by the watchdog with its pid, removed when it exits
//   .keep    Keep saved the layout: stand down
//   .done    the panel already reverted: stand down
//   .revert  revert now (the panel is going away)
//   $1 token path   $2 fallback Lua   $3 seconds   $4 hyprctl binary
var WATCHDOG_SCRIPT = [
  "token=\"$1\"; lua=\"$2\"; secs=\"$3\"; hyprctl=\"${4:-hyprctl}\"",
  "mkdir -p -- \"$(dirname -- \"$token\")\" || exit 1",
  "echo \"$$\" > \"$token.live\" || exit 1",
  "trap 'rm -f -- \"$token.live\"' EXIT",
  REVERT_FUNCTION,
  "stand_down() {",
  "  if [ -e \"$token.keep\" ] || [ -e \"$token.done\" ]; then",
  "    rm -f -- \"$token.keep\" \"$token.done\" \"$token.revert\"; exit 0",
  "  fi",
  "}",
  "ticks=$((secs * " + WATCHDOG_TICKS_PER_SECOND + "))",
  "i=0",
  "while [ \"$i\" -lt \"$ticks\" ]; do",
  "  stand_down",
  "  if [ -e \"$token.revert\" ]; then break; fi",
  "  sleep 0.2",
  "  i=$((i + 1))",
  "done",
  "stand_down",
  "rm -f -- \"$token.revert\"",
  "revert_now"
].join("\n")

// Prints how many watchdogs are still armed in the token folder, and
// clears what dead ones left behind: a .live whose pid is gone or belongs
// to another program, and .keep/.done/.revert with no live watchdog.
//   $1 token folder
var SCAN_SCRIPT = [
  "dir=\"$1\"",
  "if [ ! -d \"$dir\" ]; then echo 0; exit 0; fi",
  "live=0",
  "for f in \"$dir\"/*.live; do",
  "  [ -e \"$f\" ] || continue",
  "  pid=$(cat -- \"$f\" 2>/dev/null)",
  "  case \"$pid\" in ''|*[!0-9]*) rm -f -- \"$f\"; continue ;; esac",
  "  if [ -r \"/proc/$pid/cmdline\" ] && tr '\\000' '\\n' < \"/proc/$pid/cmdline\" | grep -qx omarchy-displays-watchdog; then",
  "    live=$((live + 1))",
  "  else",
  "    rm -f -- \"$f\"",
  "  fi",
  "done",
  "for f in \"$dir\"/*.keep \"$dir\"/*.done \"$dir\"/*.revert; do",
  "  [ -e \"$f\" ] || continue",
  "  [ -e \"${f%.*}.live\" ] || rm -f -- \"$f\"",
  "done",
  "echo \"$live\""
].join("\n")

// Runs "$@" and prints its combined output, then an exit marker line, so
// the panel reads output and exit code from one stream in one callback.
var RUN_MARKER = "__omarchy_displays_exit="
var RUN_SCRIPT = [
  "out=$(\"$@\" 2>&1); code=$?",
  "[ -n \"$out\" ] && printf '%s\\n' \"$out\"",
  "printf '" + RUN_MARKER + "%s\\n' \"$code\""
].join("\n")

//   $1 file to create
var TOUCH_SCRIPT = "mkdir -p -- \"$(dirname -- \"$1\")\" && : > \"$1\""

// Prints one status line (present | missing | unreadable), then the file.
//   $1 path
var READ_SCRIPT = [
  "if [ ! -e \"$1\" ]; then echo missing",
  "elif [ -r \"$1\" ] && [ -f \"$1\" ]; then echo present; cat -- \"$1\"",
  "else echo unreadable; fi"
].join("\n")

// Backs the file up, then replaces it atomically. Refuses when the file
// changed since it was read. Follows a symlink to the real file so a
// stowed dotfile stays a symlink. Keeps the newest BACKUPS_KEPT backups;
// a failed prune never fails the save.
//   $1 path   $2 new content   $3 content as read   $4 backup stamp
//   $5 expected state (present | missing)
var PERSIST_SCRIPT = [
  "path=\"$1\"; content=\"$2\"; original=\"$3\"; stamp=\"$4\"; expect=\"$5\"",
  "target=\"$path\"",
  "if [ -e \"$path\" ]; then target=\"$(readlink -f -- \"$path\")\" || exit 2; fi",
  "if [ -e \"$target\" ]; then",
  "  [ \"$expect\" = present ] || exit 3",
  "  current=\"$(cat -- \"$target\")\" || exit 2",
  "  [ \"$current\" = \"$original\" ] || exit 3",
  "  while [ -e \"$target.bak.$stamp\" ]; do stamp=$((stamp + 1)); done",
  "  cp -p -- \"$target\" \"$target.bak.$stamp\" || exit 4",
  "else",
  "  [ \"$expect\" = missing ] || exit 3",
  "  mkdir -p -- \"$(dirname -- \"$target\")\" || exit 2",
  "fi",
  "tmp=\"$target.tmp.$$\"",
  "printf '%s' \"$content\" > \"$tmp\" || { rm -f -- \"$tmp\"; exit 5; }",
  "mv -f -- \"$tmp\" \"$target\" || { rm -f -- \"$tmp\"; exit 5; }",
  "stamps=$(for f in \"$target\".bak.*; do",
  "  s=\"${f##*.bak.}\"",
  "  case \"$s\" in ''|*[!0-9]*) continue ;; esac",
  "  [ -f \"$f\" ] && echo \"$s\"",
  "done | sort -n)",
  "count=$(printf '%s\\n' \"$stamps\" | grep -c .)",
  "excess=$((count - " + BACKUPS_KEPT + "))",
  "if [ \"$excess\" -gt 0 ]; then",
  "  printf '%s\\n' \"$stamps\" | head -n \"$excess\" | while read -r s; do rm -f -- \"$target.bak.$s\"; done",
  "fi",
  "exit 0"
].join("\n")

// Output of RUN_SCRIPT. code is -1 when the marker never arrived.
function parseRunOutput(text) {
  var lines = String(text || "").replace(/\n+$/, "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf(RUN_MARKER) !== 0) continue
    var code = parseInt(lines[i].substring(RUN_MARKER.length), 10)
    return { code: isFinite(code) ? code : -1, output: lines.slice(0, i).join("\n") }
  }
  return { code: -1, output: lines.join("\n") }
}

// Why a hyprctl call failed, from its output and exit code; "" when it did
// not. hyprctl can exit 0 and still print an error, so the text counts too.
// A clean result only means Hyprland took the Lua. It does not prove a mode
// was accepted; compare `hyprctl monitors` for that (layoutDiff).
function commandError(run) {
  var result = run || { code: -1, output: "" }
  var lines = String(result.output || "").split("\n")
  var errorLine = ""
  for (var i = 0; i < lines.length; i++) {
    if (/error/i.test(lines[i])) {
      errorLine = lines[i].replace(/^\s+|\s+$/g, "")
      break
    }
  }
  if (errorLine) return errorLine
  if (result.code === 0) return ""
  var first = String(result.output || "").replace(/^\s+|\s+$/g, "").split("\n")[0]
  if (result.code < 0) return first || "The command did not finish"
  return first ? first + " (exit " + result.code + ")" : "Exit " + result.code
}

// What differs between the arrangement we expect and what Hyprland reports.
// Positions are compared as given, not normalized. Refresh rates on both
// sides are snapped to the advertised modes, so 29.97 and 30 differ.
// [] means it matches.
function layoutDiff(expected, live) {
  var out = []
  for (var i = 0; i < (expected || []).length; i++) {
    var want = expected[i]
    var have = entryByName(live || [], want.name)
    if (!have || !isArrangeable(have)) {
      out.push(want.name + " is not active")
      continue
    }
    if (have.width !== want.width || have.height !== want.height
        || Math.abs(have.refresh - want.refresh) > 0.005)
      out.push(want.name + " mode " + modeKey(have.width, have.height, have.refresh)
               + ", wanted " + modeKey(want.width, want.height, want.refresh))
    if (!sameScale(have.scale, want.scale))
      out.push(want.name + " scale " + formatScale(have.scale) + ", wanted " + formatScale(want.scale))
    if (have.x !== want.x || have.y !== want.y)
      out.push(want.name + " at " + have.x + "x" + have.y + ", wanted " + want.x + "x" + want.y)
  }
  return out
}

function utf8Length(text) {
  var s = String(text || "")
  var bytes = 0
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function parseReadOutput(text) {
  var source = String(text || "")
  var newline = source.indexOf("\n")
  var status = newline < 0 ? source : source.substring(0, newline)
  var body = newline < 0 ? "" : source.substring(newline + 1)
  if (status === "present") return { state: "present", text: body }
  if (status === "missing") return { state: "missing", text: "" }
  return { state: "unreadable", text: "" }
}

// Positional arguments for PERSIST_SCRIPT, after the label.
function persistArgs(plan, monitorsPath, stamp) {
  return [
    String(monitorsPath),
    plan.fileText,
    // $(cat) drops trailing newlines, so compare against the same shape.
    String(plan.fileOriginal || "").replace(/\n+$/, ""),
    String(stamp),
    plan.fileState === "present" ? "present" : "missing"
  ]
}

function persistError(exitCode) {
  var code = Number(exitCode)
  if (code === 0) return ""
  if (code === 3) return "monitors.lua changed since it was read. Nothing was saved"
  if (code === 4) return "Could not back up monitors.lua. Nothing was saved"
  if (code === 5) return "Could not write monitors.lua"
  return "Could not save monitors.lua (exit " + code + ")"
}

function backupStamp(nowMs) {
  return String(Math.floor(Number(nowMs) / 1000))
}

// ---------------------------------------------------------------- payload

// Summon payload: {"dryRun": true, "monitorsFile": "/abs/path.lua"}.
function parsePayload(payloadJson, defaultPath) {
  var out = { dryRun: false, monitorsFile: String(defaultPath || "") }
  var data = null
  try {
    data = typeof payloadJson === "string" ? JSON.parse(payloadJson || "{}") : payloadJson
  } catch (e) {
    data = null
  }
  if (!data || typeof data !== "object") return out
  if (data.dryRun === true || data.dryRun === "true") out.dryRun = true
  var file = data.monitorsFile
  if (typeof file === "string" && file.charAt(0) === "/" && luaQuote(file) !== null
      && file.indexOf("/../") < 0)
    out.monitorsFile = file
  return out
}

// ----------------------------------------------------------------- canvas

// Fits the arrangement into the canvas with spare room around it, so a
// display can be dragged to any side of the others without leaving view.
function canvasTransform(layout, canvasWidth, canvasHeight, padding) {
  var bounds = layoutBounds(layout)
  var pad = Number(padding) || 0
  var width = Math.max(1, Number(canvasWidth) - pad * 2)
  var height = Math.max(1, Number(canvasHeight) - pad * 2)
  if (bounds.w <= 0 || bounds.h <= 0) return { k: 1, originX: pad, originY: pad }

  var largestW = 0
  var largestH = 0
  for (var i = 0; i < layout.length; i++) {
    var size = logicalSize(layout[i])
    largestW = Math.max(largestW, size.width)
    largestH = Math.max(largestH, size.height)
  }
  var roomW = bounds.w + largestW
  var roomH = bounds.h + largestH
  var k = Math.min(width / roomW, height / roomH)
  return {
    k: k,
    originX: pad + (width - bounds.w * k) / 2 - bounds.x * k,
    originY: pad + (height - bounds.h * k) / 2 - bounds.y * k
  }
}

function toCanvas(rect, view) {
  return {
    x: view.originX + rect.x * view.k,
    y: view.originY + rect.y * view.k,
    w: rect.w * view.k,
    h: rect.h * view.k
  }
}

function toLogical(canvasX, canvasY, view) {
  var k = view.k > 0 ? view.k : 1
  return {
    x: Math.round((canvasX - view.originX) / k),
    y: Math.round((canvasY - view.originY) / k)
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    PLUGIN_ID: PLUGIN_ID,
    CONFIRM_SECONDS: CONFIRM_SECONDS,
    WATCHDOG_GRACE_SECONDS: WATCHDOG_GRACE_SECONDS,
    BLOCK_BEGIN: BLOCK_BEGIN,
    BLOCK_END: BLOCK_END,
    SCALE_PRESETS: SCALE_PRESETS,
    MIN_SHARED_EDGE: MIN_SHARED_EDGE,
    MAX_ARG_BYTES: MAX_ARG_BYTES,
    BACKUPS_KEPT: BACKUPS_KEPT,
    SETTLE_TIMEOUT_MS: SETTLE_TIMEOUT_MS,
    SETTLE_POLL_MS: SETTLE_POLL_MS,
    RUN_MARKER: RUN_MARKER,
    REVERT_SCRIPT: REVERT_SCRIPT,
    WATCHDOG_SCRIPT: WATCHDOG_SCRIPT,
    SCAN_SCRIPT: SCAN_SCRIPT,
    RUN_SCRIPT: RUN_SCRIPT,
    TOUCH_SCRIPT: TOUCH_SCRIPT,
    READ_SCRIPT: READ_SCRIPT,
    PERSIST_SCRIPT: PERSIST_SCRIPT,
    roundTo: roundTo,
    formatRefresh: formatRefresh,
    formatScale: formatScale,
    cleanScale: cleanScale,
    sameScale: sameScale,
    parseMode: parseMode,
    modeKey: modeKey,
    parseModes: parseModes,
    resolutionOptions: resolutionOptions,
    refreshOptions: refreshOptions,
    hasMode: hasMode,
    nearestRefresh: nearestRefresh,
    scaleOptions: scaleOptions,
    parseMonitors: parseMonitors,
    isArrangeable: isArrangeable,
    arrangeable: arrangeable,
    skipped: skipped,
    cloneLayout: cloneLayout,
    indexOfName: indexOfName,
    entryByName: entryByName,
    displayLabel: displayLabel,
    modeLabel: modeLabel,
    logicalSize: logicalSize,
    rectOf: rectOf,
    rectsOverlap: rectsOverlap,
    sideOfRect: sideOfRect,
    sideOf: sideOf,
    layoutBounds: layoutBounds,
    normalizeLayout: normalizeLayout,
    overlappingPairs: overlappingPairs,
    isConnected: isConnected,
    alignAlong: alignAlong,
    nearestSlot: nearestSlot,
    closeGaps: closeGaps,
    dropMonitor: dropMonitor,
    placeOnSide: placeOnSide,
    relationBetween: relationBetween,
    reflow: reflow,
    setScale: setScale,
    setResolution: setResolution,
    setRefresh: setRefresh,
    layoutChanges: layoutChanges,
    hasChanges: hasChanges,
    validateLayout: validateLayout,
    luaQuote: luaQuote,
    stripLuaComments: stripLuaComments,
    findMonitorRules: findMonitorRules,
    findMonitorSelectors: findMonitorSelectors,
    CONFIGURED_REFRESH_TOLERANCE: CONFIGURED_REFRESH_TOLERANCE,
    configuredRefresh: configuredRefresh,
    selectorMatches: selectorMatches,
    selectorFor: selectorFor,
    ruleLua: ruleLua,
    applyLua: applyLua,
    revertLua: revertLua,
    managedBlock: managedBlock,
    removeManagedBlock: removeManagedBlock,
    upsertManagedBlock: upsertManagedBlock,
    buildPlan: buildPlan,
    planPreview: planPreview,
    confirmState: confirmState,
    watchdogSeconds: watchdogSeconds,
    parseReadOutput: parseReadOutput,
    parseRunOutput: parseRunOutput,
    commandError: commandError,
    layoutDiff: layoutDiff,
    utf8Length: utf8Length,
    persistArgs: persistArgs,
    persistError: persistError,
    backupStamp: backupStamp,
    parsePayload: parsePayload,
    canvasTransform: canvasTransform,
    toCanvas: toCanvas,
    toLogical: toLogical
  }
}
