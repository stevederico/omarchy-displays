import Quickshell
import Quickshell.Io
import QtQuick
import qs.Commons
import qs.Ui
import "DisplaysLogic.js" as Logic

// Displays: arrange monitors like macOS Displays > Arrange.
//
// Nothing here touches Hyprland until Apply is pressed. Loading only reads
// (`hyprctl monitors all -j` and monitors.lua). Apply is live-only through
// `hyprctl eval`; monitors.lua is written on Keep and never before.
Item {
  id: root

  property var shell: null
  property var manifest: null

  property bool opened: false
  property bool closingFromHost: false

  // loading | editing | confirming | saving | reverting
  property string phase: "loading"
  readonly property bool busy: root.phase === "confirming" || root.phase === "saving"
                               || root.phase === "reverting"
  property bool dryRun: false
  readonly property string defaultMonitorsPath: Quickshell.env("HOME") + "/.config/hypr/monitors.lua"
  property string monitorsPath: root.defaultMonitorsPath
  readonly property string runtimeDir: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/omarchy-displays"

  property var snapshot: []
  property var layout: []
  property string selectedName: ""
  property string anchorName: ""
  property string fileText: ""
  property string fileState: ""
  property bool monitorsLoaded: false
  property bool fileLoaded: false

  // The plan that is live and waiting for Keep or Revert.
  property var plan: null
  property string token: ""
  // Why Keep could not save, shown on the confirm pane with Revert.
  property string saveError: ""
  // Watchdogs from an earlier Apply that are still armed. Apply waits.
  property int liveWatchdogs: 0
  property bool applyQueued: false

  // Waits for `hyprctl monitors` to match `settleExpected`.
  // settleFor: "" | "apply" | "revert"
  property string settleFor: ""
  property var settleExpected: []
  property real settleDeadline: 0
  property string settleNote: ""
  property string revertReason: ""
  property string revertTrouble: ""
  property bool revertOk: false
  property real confirmStartedMs: 0
  property int remaining: Logic.CONFIRM_SECONDS
  property real confirmProgress: 0

  property string statusText: ""
  property bool statusIsError: false
  property string previewText: ""
  property bool previewOpen: false

  readonly property var original: Logic.normalizeLayout(Logic.arrangeable(root.snapshot))
  readonly property var ignored: Logic.skipped(root.snapshot)
  readonly property var selected: Logic.entryByName(root.layout, root.selectedName)
  readonly property var check: Logic.validateLayout(root.layout)
  readonly property bool dirty: Logic.hasChanges(root.original, root.layout)
  readonly property bool editable: root.phase === "editing"
  readonly property string pluginId: (root.manifest && root.manifest.id) || Logic.PLUGIN_ID

  property color background: Color.background
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property color muted: Color.muted
  property string fontFamily: Style.font.family

  // ------------------------------------------------------------ lifecycle

  function open(payloadJson) {
    // A second summon while a layout is live only brings the window back.
    // Reloading here would throw away the snapshot the revert depends on.
    if (root.busy) {
      root.opened = true
      window.visible = true
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      return
    }
    var payload = Logic.parsePayload(String(payloadJson || ""), root.defaultMonitorsPath)
    root.dryRun = payload.dryRun
    root.monitorsPath = payload.monitorsFile
    root.closingFromHost = false
    root.opened = true
    root.previewOpen = false
    root.setStatus("", false)
    window.visible = true
    root.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    root.closingFromHost = true
    // Walking away is not a yes. The window and its processes are about to
    // go, so the detached watchdog does this revert.
    if (root.busy) {
      root.touch(root.token + ".revert")
      root.plan = null
      root.settleFor = ""
      root.phase = "editing"
    }
    root.opened = false
    window.visible = false
    root.closingFromHost = false
  }

  function dismiss() {
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
    else root.close()
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  Component.onDestruction: {
    if (root.busy) root.touch(root.token + ".revert")
  }

  // -------------------------------------------------------------- loading

  function refresh() {
    root.phase = "loading"
    root.monitorsLoaded = false
    root.fileLoaded = false
    if (!monitorsProc.running) monitorsProc.running = true
    if (!fileProc.running) fileProc.running = true
    root.scanWatchdogs()
  }

  function scanWatchdogs() {
    if (!scanProc.running) scanProc.running = true
  }

  function loadScan(raw) {
    var count = parseInt(String(raw || "").replace(/\s+$/, ""), 10)
    root.liveWatchdogs = isFinite(count) && count > 0 ? count : 0
    if (!root.applyQueued) return
    root.applyQueued = false
    if (root.liveWatchdogs > 0)
      root.setStatus("An earlier Apply is still waiting to revert. Try again in a few seconds", true)
    else
      root.startApply()
  }

  function loadMonitors(raw) {
    root.snapshot = Logic.parseMonitors(raw)
    root.layout = Logic.normalizeLayout(Logic.arrangeable(root.snapshot))
    if (!Logic.entryByName(root.layout, root.selectedName)) {
      var pick = ""
      for (var i = 0; i < root.layout.length; i++)
        if (root.layout[i].focused) pick = root.layout[i].name
      if (!pick && root.layout.length) pick = root.layout[0].name
      root.selectedName = pick
    }
    root.pickAnchor()
    root.monitorsLoaded = true
    root.settle()
  }

  function loadFile(raw) {
    var read = Logic.parseReadOutput(raw)
    root.fileText = read.text
    root.fileState = read.state
    root.fileLoaded = true
    root.settle()
  }

  function settle() {
    if (root.phase === "loading" && root.monitorsLoaded && root.fileLoaded) root.phase = "editing"
  }

  function pickAnchor() {
    var current = Logic.entryByName(root.layout, root.anchorName)
    if (current && root.anchorName !== root.selectedName) return
    root.anchorName = ""
    for (var i = 0; i < root.layout.length; i++) {
      if (root.layout[i].name === root.selectedName) continue
      root.anchorName = root.layout[i].name
      return
    }
  }

  // -------------------------------------------------------------- editing

  function setStatus(text, isError) {
    root.statusText = text
    root.statusIsError = isError === true
  }

  function edit(nextLayout) {
    if (!root.editable) return
    root.layout = nextLayout
    root.setStatus("", false)
  }

  function select(name) {
    root.selectedName = name
    root.pickAnchor()
  }

  function dropTile(name, canvasX, canvasY, view) {
    var spot = Logic.toLogical(canvasX, canvasY, view)
    root.edit(Logic.dropMonitor(root.layout, name, spot.x, spot.y, Style.space(14) / view.k))
  }

  function chooseResolution(width, height) {
    root.edit(Logic.setResolution(root.layout, root.selectedName, width, height))
  }

  function chooseRefresh(refresh) {
    root.edit(Logic.setRefresh(root.layout, root.selectedName, refresh))
  }

  function chooseScale(scale) {
    root.edit(Logic.setScale(root.layout, root.selectedName, scale))
  }

  function chooseSide(side) {
    root.edit(Logic.placeOnSide(root.layout, root.selectedName, root.anchorName, side, "start"))
  }

  function resetLayout() {
    root.edit(Logic.cloneLayout(root.original))
  }

  function currentPlan() {
    return Logic.buildPlan({
      snapshot: root.snapshot,
      layout: root.layout,
      fileText: root.fileText,
      fileState: root.fileState
    })
  }

  // Callable over IPC: omarchy-shell shell call <id> planText ''
  function planText(arg) {
    return Logic.planPreview(root.currentPlan(), root.monitorsPath)
  }

  function showPreview() {
    root.previewText = (root.dryRun ? "DRY RUN. Apply does nothing.\n\n" : "") + root.planText("")
    root.previewOpen = true
  }

  // ------------------------------------------------- apply / keep / revert

  function touch(path) {
    Quickshell.execDetached(["sh", "-c", Logic.TOUCH_SCRIPT, "omarchy-displays-touch", String(path)])
  }

  function apply() {
    if (!root.editable) return
    var next = root.currentPlan()
    if (!next.ok) {
      root.setStatus(next.errors.length ? next.errors[0].message : "This layout cannot be applied", true)
      return
    }
    if (next.changes.length === 0) {
      root.setStatus("Nothing to apply", false)
      return
    }
    if (root.dryRun) {
      root.previewText = "DRY RUN. Nothing was applied.\n\n" + Logic.planPreview(next, root.monitorsPath)
      root.previewOpen = true
      return
    }
    // Never stack a second watchdog on one that is still armed: its revert
    // would land in the middle of this Apply.
    root.applyQueued = true
    root.scanWatchdogs()
  }

  function startApply() {
    if (!root.editable) return
    var next = root.currentPlan()
    if (!next.ok || next.changes.length === 0) return

    root.plan = next
    root.saveError = ""
    root.settleNote = ""
    root.token = root.runtimeDir + "/" + Date.now()
    // The watchdog goes first, so a revert is already scheduled by the time
    // the layout changes, whatever that change does to this process.
    Quickshell.execDetached(["sh", "-c", Logic.WATCHDOG_SCRIPT, "omarchy-displays-watchdog",
                             root.token, String(next.revertLua),
                             String(Logic.watchdogSeconds(Logic.CONFIRM_SECONDS)), "hyprctl"])
    root.confirmStartedMs = Date.now()
    root.remaining = Logic.CONFIRM_SECONDS
    root.confirmProgress = 0
    root.previewOpen = false
    root.setStatus("", false)
    root.phase = "confirming"
    applyProc.command = ["sh", "-c", Logic.RUN_SCRIPT, "omarchy-displays-run",
                         "hyprctl", "eval", String(next.applyLua)]
    applyProc.running = true
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function applyFinished(raw) {
    if (root.phase !== "confirming" || !root.plan) return
    var failure = Logic.commandError(Logic.parseRunOutput(raw))
    if (failure) {
      root.revert("failed", failure)
      return
    }
    // A clean eval does not prove Hyprland took each mode. Watch what it
    // reports and say so on the confirm pane if it differs.
    root.startSettle("apply", root.plan.layout)
  }

  function keep() {
    if (root.phase !== "confirming" || !root.plan) return
    if (!root.plan.canPersist || root.saveError) {
      var why = root.saveError
        || (root.plan.warnings.length ? root.plan.warnings[0].message : "monitors.lua cannot be written")
      root.touch(root.token + ".keep")
      root.setStatus("Layout is live but not saved. " + why, true)
      root.plan = null
      root.settleFor = ""
      root.refresh()
      return
    }
    root.phase = "saving"
    var args = Logic.persistArgs(root.plan, root.monitorsPath, Logic.backupStamp(Date.now()))
    persistProc.command = ["sh", "-c", Logic.RUN_SCRIPT, "omarchy-displays-run",
                           "sh", "-c", Logic.PERSIST_SCRIPT, "omarchy-displays-persist",
                           String(args[0]), String(args[1]), String(args[2]), String(args[3]), String(args[4])]
    persistProc.running = true
  }

  function persistFinished(raw) {
    if (root.phase !== "saving") return
    var run = Logic.parseRunOutput(raw)
    var failure = Logic.persistError(run.code)
    if (failure) {
      // The layout is still live and the watchdog still armed. Go back to
      // the question, now with Revert or keep-unsaved as the choices.
      root.saveError = failure
      root.phase = "confirming"
      return
    }
    // Only now may the watchdog stand down.
    root.touch(root.token + ".keep")
    root.setStatus("Saved to " + root.monitorsPath, false)
    root.plan = null
    root.settleFor = ""
    root.refresh()
  }

  function revert(reason, detail) {
    if (root.phase !== "confirming") return
    root.revertReason = reason
    root.revertTrouble = detail ? String(detail) : ""
    root.settleFor = ""
    root.phase = "reverting"
    revertProc.command = ["sh", "-c", Logic.RUN_SCRIPT, "omarchy-displays-run",
                          "sh", "-c", Logic.REVERT_SCRIPT, "omarchy-displays-revert",
                          String(root.plan ? root.plan.revertLua : ""), "hyprctl"]
    revertProc.running = true
  }

  function revertFinished(raw) {
    if (root.phase !== "reverting") return
    var run = Logic.parseRunOutput(raw)
    if (run.code === 0) {
      root.touch(root.token + ".done")
    } else {
      // This revert failed. Hand it to the watchdog as well, then see
      // what Hyprland ends up showing.
      root.touch(root.token + ".revert")
      root.revertTrouble = (root.revertTrouble ? root.revertTrouble + ". " : "")
        + "Revert failed: " + (Logic.commandError(run) || "unknown error")
    }
    root.revertOk = run.code === 0
    root.startSettle("revert", Logic.arrangeable(root.snapshot))
  }

  function revertMessage(matched, diff) {
    var lead
    if (root.revertReason === "timeout") lead = "No answer in " + Logic.CONFIRM_SECONDS + " seconds. "
    else if (root.revertReason === "failed") lead = "Hyprland refused the layout. "
    else lead = ""
    var trouble = root.revertTrouble ? root.revertTrouble + ". " : ""
    if (matched)
      return { text: lead + trouble + "Reverted", error: root.revertReason === "failed" || !root.revertOk }
    if (!root.revertOk)
      return { text: lead + trouble + "The layout may still be wrong. Run hyprctl reload", error: true }
    return { text: lead + trouble + "Reverted to monitors.lua, which differs from before Apply: "
                   + diff.join("; "), error: true }
  }

  function startSettle(target, expected) {
    root.settleFor = target
    root.settleExpected = expected
    root.settleDeadline = Date.now() + Logic.SETTLE_TIMEOUT_MS
    root.pollSettle()
  }

  function pollSettle() {
    if (root.settleFor && !settleProc.running) settleProc.running = true
  }

  function settleRead(raw) {
    var target = root.settleFor
    if (!target) return
    if (target === "apply" && root.phase !== "confirming" && root.phase !== "saving") {
      root.settleFor = ""
      return
    }
    var diff = Logic.layoutDiff(root.settleExpected, Logic.parseMonitors(raw))
    var matched = diff.length === 0
    if (!matched && Date.now() < root.settleDeadline) return
    root.settleFor = ""

    if (target === "apply") {
      root.settleNote = matched ? "" : "Hyprland shows something else: " + diff.join("; ")
      return
    }
    var message = root.revertMessage(matched, diff)
    root.plan = null
    root.refresh()
    root.setStatus(message.text, message.error)
  }

  function handleKey(event) {
    event.accepted = true
    if (root.phase === "confirming") {
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) root.keep()
      else if (event.key === Qt.Key_Escape) root.revert("user")
      return
    }
    if (root.busy) return
    if (event.key !== Qt.Key_Escape) {
      event.accepted = false
      return
    }
    if (root.previewOpen) root.previewOpen = false
    else root.dismiss()
  }

  Timer {
    id: confirmTimer
    interval: 200
    repeat: true
    running: root.phase === "confirming"
    onTriggered: {
      var state = Logic.confirmState(root.confirmStartedMs, Date.now(), Logic.CONFIRM_SECONDS)
      root.remaining = state.remaining
      root.confirmProgress = state.progress
      if (state.expired) root.revert("timeout")
    }
  }

  Timer {
    id: settleTimer
    interval: Logic.SETTLE_POLL_MS
    repeat: true
    running: root.settleFor !== ""
    onTriggered: root.pollSettle()
  }

  // A watchdog stands down within a fraction of a second of Keep or a
  // revert. Look again until it is gone so Apply comes back on its own.
  Timer {
    interval: 1000
    repeat: true
    running: root.opened && root.editable && root.liveWatchdogs > 0
    onTriggered: root.scanWatchdogs()
  }

  Process {
    id: settleProc
    command: ["hyprctl", "monitors", "all", "-j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.settleRead(this.text)
    }
  }

  Process {
    id: scanProc
    command: ["sh", "-c", Logic.SCAN_SCRIPT, "omarchy-displays-scan", root.runtimeDir]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.loadScan(this.text)
    }
  }

  Process {
    id: revertProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.revertFinished(this.text)
    }
  }

  Process {
    id: monitorsProc
    command: ["hyprctl", "monitors", "all", "-j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.loadMonitors(this.text)
    }
  }

  Process {
    id: fileProc
    command: ["sh", "-c", Logic.READ_SCRIPT, "omarchy-displays-read", root.monitorsPath]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.loadFile(this.text)
    }
  }

  // RUN_SCRIPT folds the exit code into stdout, so one callback sees both.
  Process {
    id: applyProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyFinished(this.text)
    }
  }

  Process {
    id: persistProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.persistFinished(this.text)
    }
  }

  // --------------------------------------------------------------- window

  FloatingWindow {
    id: window
    title: "Displays"
    visible: false
    color: root.background
    implicitWidth: Style.space(860)
    implicitHeight: Style.space(720)
    minimumSize: Qt.size(Style.space(640), Style.space(560))

    onVisibleChanged: {
      if (visible) {
        Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      } else if (!root.closingFromHost) {
        if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
        else root.close()
      }
    }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.onPressed: function(event) { root.handleKey(event) }
    }

    Item {
      id: content
      anchors.fill: parent
      anchors.margins: Style.spacing.panelPadding

      // ---------- header ----------
      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.spacing.xxs

        Text {
          text: root.dryRun ? "Displays · dry run" : "Displays"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
          font.bold: true
        }

        Text {
          width: parent.width
          text: root.phase === "loading" ? "Reading displays"
            : "Drag a display to where it sits on your desk. Nothing changes until Apply"
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }
      }

      // ---------- arrangement ----------
      Rectangle {
        id: canvas
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Style.spacing.panelGap
        anchors.bottom: settings.top
        anchors.bottomMargin: Style.spacing.panelGap
        radius: Style.cornerRadius
        color: Style.normalFillFor(root.foreground, root.accent)
        border.width: 1
        border.color: Style.normalBorderFor(root.foreground, root.accent)
        clip: true

        readonly property var view: Logic.canvasTransform(root.layout, canvas.width, canvas.height, Style.space(16))

        Text {
          anchors.centerIn: parent
          visible: root.layout.length === 0 && root.phase !== "loading"
          text: "No active displays"
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        Repeater {
          model: root.layout

          Rectangle {
            id: tile
            required property var modelData
            required property int index

            readonly property var box: Logic.toCanvas(Logic.rectOf(tile.modelData), canvas.view)
            readonly property bool isSelected: tile.modelData.name === root.selectedName

            x: box.x
            y: box.y
            width: box.w
            height: box.h
            z: tileMouse.drag.active ? 3 : (isSelected ? 2 : 1)
            radius: Style.cornerRadius
            color: isSelected ? Style.selectedFillFor(root.foreground, root.accent)
                              : Style.hoverFillFor(root.foreground, root.accent)
            border.width: isSelected ? 2 : 1
            border.color: isSelected ? root.accent : Style.normalBorderFor(root.foreground, root.accent)
            opacity: tileMouse.drag.active ? 0.8 : 1

            Column {
              anchors.centerIn: parent
              width: parent.width - Style.spacing.lg * 2
              spacing: Style.spacing.xxs

              Text {
                width: parent.width
                text: Logic.displayLabel(tile.modelData)
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
                horizontalAlignment: Text.AlignHCenter
                elide: Text.ElideRight
              }

              Text {
                width: parent.width
                text: tile.modelData.name
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                horizontalAlignment: Text.AlignHCenter
                elide: Text.ElideRight
              }

              Text {
                width: parent.width
                text: tile.modelData.width + " × " + tile.modelData.height
                      + " · " + Logic.formatScale(Logic.roundTo(tile.modelData.scale, 2)) + "x"
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                horizontalAlignment: Text.AlignHCenter
                elide: Text.ElideRight
              }
            }

            MouseArea {
              id: tileMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: root.editable ? Qt.OpenHandCursor : Qt.ArrowCursor
              drag.target: root.editable && root.layout.length > 1 ? tile : null
              drag.threshold: 2
              drag.minimumX: 0
              drag.maximumX: canvas.width - tile.width
              drag.minimumY: 0
              drag.maximumY: canvas.height - tile.height
              onPressed: root.select(tile.modelData.name)
              onReleased: {
                var droppedX = tile.x
                var droppedY = tile.y
                // Dragging assigned x and y and broke their bindings. Put
                // them back so the tile follows the layout again.
                tile.x = Qt.binding(function() { return tile.box.x })
                tile.y = Qt.binding(function() { return tile.box.y })
                if (Math.abs(droppedX - tile.box.x) < 1 && Math.abs(droppedY - tile.box.y) < 1) return
                root.dropTile(tile.modelData.name, droppedX, droppedY, canvas.view)
              }
            }
          }
        }
      }

      // ---------- settings for the selected display ----------
      Item {
        id: settings
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: footer.top
        anchors.bottomMargin: Style.spacing.panelGap
        height: Style.space(250)
        enabled: root.editable
        opacity: root.editable ? 1 : 0.5

        Text {
          id: settingsTitle
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          text: root.selected
            ? Logic.displayLabel(root.selected) + " · " + root.selected.name + " · " + Logic.modeLabel(root.selected)
            : "No display selected"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: true
          elide: Text.ElideRight
        }

        Column {
          id: resolutionColumn
          anchors.left: parent.left
          anchors.top: settingsTitle.bottom
          anchors.topMargin: Style.spacing.lg
          anchors.bottom: parent.bottom
          width: Math.round(parent.width * 0.34)
          spacing: Style.spacing.md

          PanelSectionHeader {
            id: resolutionHeader
            text: "RESOLUTION"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          ListView {
            id: resolutionList
            width: parent.width
            height: parent.height - resolutionHeader.height - parent.spacing
            clip: true
            spacing: Style.spacing.xxs
            boundsBehavior: Flickable.StopAtBounds
            model: root.selected ? Logic.resolutionOptions(root.selected) : []

            delegate: Button {
              required property var modelData
              width: resolutionList.width
              leftAlign: true
              text: modelData.label
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              selected: !!root.selected && root.selected.width === modelData.width
                        && root.selected.height === modelData.height
              onClicked: root.chooseResolution(modelData.width, modelData.height)
            }
          }
        }

        Column {
          anchors.left: resolutionColumn.right
          anchors.leftMargin: Style.spacing.huge
          anchors.right: parent.right
          anchors.top: settingsTitle.bottom
          anchors.topMargin: Style.spacing.lg
          spacing: Style.spacing.md

          PanelSectionHeader {
            text: "REFRESH RATE"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Flow {
            width: parent.width
            spacing: Style.spacing.xs

            Repeater {
              model: root.selected
                ? Logic.refreshOptions(root.selected, root.selected.width, root.selected.height) : []

              Button {
                required property var modelData
                text: Logic.formatRefresh(modelData) + " Hz"
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                selected: !!root.selected && root.selected.refresh === modelData
                onClicked: root.chooseRefresh(modelData)
              }
            }
          }

          PanelSectionHeader {
            text: "SCALE"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Flow {
            width: parent.width
            spacing: Style.spacing.xs

            Repeater {
              model: root.selected ? Logic.scaleOptions(root.selected) : []

              Button {
                required property var modelData
                text: modelData.label
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                selected: !!root.selected && Logic.sameScale(root.selected.scale, modelData.value)
                onClicked: root.chooseScale(modelData.value)
              }
            }
          }

          PanelSectionHeader {
            visible: root.layout.length > 1
            text: "SIDE"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Flow {
            visible: root.layout.length > 1
            width: parent.width
            spacing: Style.spacing.xs

            Repeater {
              model: [
                { side: "left", label: "Left of" },
                { side: "right", label: "Right of" },
                { side: "above", label: "Above" },
                { side: "below", label: "Below" }
              ]

              Button {
                required property var modelData
                text: modelData.label
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                selected: Logic.sideOf(root.layout, root.selectedName, root.anchorName) === modelData.side
                onClicked: root.chooseSide(modelData.side)
              }
            }

            Repeater {
              model: root.layout

              Button {
                required property var modelData
                visible: modelData.name !== root.selectedName
                text: Logic.displayLabel(modelData)
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                active: modelData.name === root.anchorName
                onClicked: root.anchorName = modelData.name
              }
            }
          }
        }
      }

      // ---------- footer ----------
      Item {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: footerButtons.implicitHeight

        Text {
          anchors.left: parent.left
          anchors.right: footerButtons.left
          anchors.rightMargin: Style.spacing.lg
          anchors.verticalCenter: parent.verticalCenter
          text: {
            if (root.statusText) return root.statusText
            if (root.check.errors.length) return root.check.errors[0].message
            if (root.check.warnings.length) return root.check.warnings[0].message
            if (root.liveWatchdogs > 0 && root.phase !== "loading")
              return "An earlier Apply is still waiting to revert"
            if (root.fileState === "unreadable" && root.phase !== "loading")
              return "monitors.lua cannot be read. Keep will not save"
            if (root.ignored.length)
              return "Not arranged: " + root.ignored.map(function(d) { return d.name }).join(", ")
            return root.dirty ? "Unapplied changes" : ""
          }
          color: (root.statusText ? root.statusIsError : root.check.errors.length > 0)
            ? root.urgent : root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }

        Row {
          id: footerButtons
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.controlGap

          Button {
            text: "Reset"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.editable && root.dirty
            opacity: enabled ? 1 : 0.4
            onClicked: root.resetLayout()
          }

          Button {
            text: "Preview"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.editable
            opacity: enabled ? 1 : 0.4
            onClicked: root.showPreview()
          }

          Button {
            text: root.dryRun ? "Apply (dry run)" : "Apply"
            bordered: true
            active: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.editable && root.dirty && root.check.ok && root.liveWatchdogs === 0
            opacity: enabled ? 1 : 0.4
            onClicked: root.apply()
          }
        }
      }
    }

    // ---------- preview ----------
    Rectangle {
      id: previewPane
      anchors.fill: parent
      visible: root.previewOpen
      z: 40
      color: root.background

      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.AllButtons
        onWheel: function(wheel) { wheel.accepted = true }
      }

      Flickable {
        id: previewFlick
        anchors.fill: parent
        anchors.margins: Style.spacing.panelPadding
        anchors.bottomMargin: previewClose.height + Style.spacing.panelPadding * 2
        clip: true
        contentWidth: width
        contentHeight: previewBody.implicitHeight
        boundsBehavior: Flickable.StopAtBounds

        Text {
          id: previewBody
          width: previewFlick.width
          textFormat: Text.PlainText
          text: root.previewText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WrapAnywhere
        }
      }

      Button {
        id: previewClose
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: Style.spacing.panelPadding
        text: "Close"
        bordered: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        onClicked: root.previewOpen = false
      }
    }

    // ---------- keep these settings? ----------
    Rectangle {
      id: confirmPane
      anchors.fill: parent
      visible: root.busy
      z: 50
      color: root.background

      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.AllButtons
        onWheel: function(wheel) { wheel.accepted = true }
      }

      Column {
        anchors.centerIn: parent
        width: Math.min(parent.width - Style.spacing.panelPadding * 2, Style.space(460))
        spacing: Style.spacing.panelGap

        Text {
          width: parent.width
          text: root.phase === "saving" ? "Saving"
            : root.phase === "reverting" ? "Reverting"
            : root.saveError ? "Not saved" : "Keep these settings?"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.display
          font.bold: true
          horizontalAlignment: Text.AlignHCenter
        }

        Text {
          width: parent.width
          visible: root.phase === "confirming"
          text: "Reverting in " + root.remaining + (root.remaining === 1 ? " second" : " seconds")
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
          horizontalAlignment: Text.AlignHCenter
        }

        Text {
          width: parent.width
          visible: root.phase === "confirming" && (root.saveError !== "" || root.settleNote !== "")
          text: [root.saveError, root.settleNote].filter(function(t) { return t !== "" }).join("\n")
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.Wrap
          horizontalAlignment: Text.AlignHCenter
        }

        Rectangle {
          width: parent.width
          height: Style.space(4)
          radius: height / 2
          visible: root.phase === "confirming"
          color: Style.normalFillFor(root.foreground, root.accent)

          Rectangle {
            width: parent.width * (1 - root.confirmProgress)
            height: parent.height
            radius: parent.radius
            color: root.accent
          }
        }

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          visible: root.phase === "confirming"
          spacing: Style.spacing.panelGap

          Button {
            text: "Revert"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.title
            horizontalPadding: Style.spacing.huge
            onClicked: root.revert("user")
          }

          Button {
            text: root.saveError ? "Keep unsaved" : "Keep"
            bordered: true
            active: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.title
            horizontalPadding: Style.spacing.huge
            onClicked: root.keep()
          }
        }

        Text {
          width: parent.width
          visible: root.phase === "confirming"
          text: (root.saveError ? "Return keeps it live until the next reload" : "Return keeps")
                + " · Esc reverts · closing the window reverts"
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }
      }
    }
  }
}
