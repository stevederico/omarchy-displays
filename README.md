# Omarchy Displays

Arrange monitors on [Omarchy](https://omarchy.org/) Quattro the way macOS
Displays > Arrange does it.

Displays is a **normal window**. Each monitor is a rectangle. Drag one to
where it sits on your desk and it snaps flush against its neighbor. Pick a
resolution, refresh rate, and scale per monitor. Press **Apply**, then answer
**Keep these settings?** within 15 seconds or the old arrangement comes back
on its own.

## How it works

| Step | What happens | What is written |
|------|--------------|-----------------|
| Open | Reads `hyprctl monitors all -j` and `monitors.lua` | Nothing |
| Drag, pick scale or mode | Edits the arrangement in the window only | Nothing |
| Preview | Shows the exact Lua for apply, revert, and save | Nothing |
| Apply | Starts the revert watchdog, then `hyprctl eval` with the new rules | Nothing |
| Keep | Saves the rules, then stops the watchdog | `monitors.lua` plus a backup |
| Revert or timeout | `hyprctl reload`, then waits until `hyprctl monitors` shows the old layout | Nothing |
| Closing the window while a layout is live | The watchdog reverts at once | Nothing |

Apply is live-only. `~/.config/hypr/monitors.lua` is not touched until you
press Keep, so `hyprctl reload` or logging out always returns to the saved
arrangement.

### How a revert works

Because `monitors.lua` is untouched until Keep, a revert is
`hyprctl reload`. That restores every option your rules set, not just mode,
position, and scale. Only if the reload fails does Displays fall back to
`hyprctl eval` with the pre-Apply layout by connector name.

A revert is reported only after it ran and `hyprctl monitors` shows the
layout from before Apply (it waits up to 5 seconds). If the reloaded layout
differs from what was live before Apply, the window says what differs.

### The revert watchdog

The 15-second revert does not depend on the window. Before the layout
changes, Displays starts a small detached `sh` process with the same
reload-then-eval revert. It fires 17 seconds after Apply unless Keep has
saved the file or the window already reverted. If the new layout takes down
the screen, the panel, or the whole shell, the watchdog still reverts.

While a watchdog from an earlier Apply is still armed, Apply waits.
Its token files live in `$XDG_RUNTIME_DIR/omarchy-displays/`.

### When Hyprland says no

`hyprctl eval` output is read. Any `error` line reverts at once and is
shown in the window. A clean eval does not prove Hyprland took each mode,
so Displays also compares `hyprctl monitors` with the layout it asked for
and shows any difference while you decide.

### What Keep writes

Keep adds one managed block to the end of `monitors.lua`, in the same
`hl.monitor({ ... })` format Omarchy uses:

```lua
-- omarchy-displays: begin
-- Written by the Displays plugin. Edits inside this block are overwritten.
-- Delete the whole block to fall back to the rules above it.
hl.monitor({ output = "desc:Dell Inc. DELL U2719D", mode = "2560x1440@60", position = "0x0", scale = 1 })
hl.monitor({ output = "desc:Samsung Electric Company U28H75x", mode = "3840x2160@30", position = "2560x0", scale = 1.5 })
-- omarchy-displays: end
```

- Everything outside the block is kept byte for byte: your comments,
  variables, workspace rules, and `GDK_SCALE`.
- The block goes last because Hyprland lets the last matching monitor rule
  win.
- Saving again replaces the block. It never stacks.
- A refresh rate your own rule writes is kept when it is within 0.1 Hz of
  the chosen mode: `@60` stays `@60` on a 59.95 Hz panel.
- Displays are matched by panel (`desc:`), not connector, so a display that
  moves from `DP-1` to `DP-2` keeps its place. If your own rules already
  name a selector for a display, the block reuses it. Identical twin
  displays fall back to connector names.
- The previous file is copied to `monitors.lua.bak.<unix time>` first.
  The newest 5 backups are kept.
- If the file changed after Displays read it, or the save fails for any
  reason, nothing is saved, the watchdog stays armed, and the window asks
  again: Revert, or keep the layout live without saving.
- Files over 120 KiB are not saved (the Linux single-argument limit is
  128 KiB).
- A symlinked `monitors.lua` stays a symlink.

## Requirements and safety

- Omarchy Quattro with the Quickshell shell and Hyprland (Lua config).
- No sudo, installer, package manager, service, or network access.
- Runs `hyprctl monitors all -j` (read), `hyprctl eval` (on Apply, and as
  the fallback revert), and `hyprctl reload` (the revert).
- Writes `monitors.lua` and its backups on Keep, and short-lived token files
  under `$XDG_RUNTIME_DIR/omarchy-displays/`. Nothing else.
- Disabled and mirrored outputs are listed but never changed.
- Rotation (`transform`) is preserved, not editable.

## Install

```sh
omarchy plugin add https://github.com/stevederico/omarchy-displays.git
```

The plugin lands disabled. Read the code and try it the safe way (below)
before trusting it with your real `monitors.lua`. Then:

```sh
omarchy plugin enable io.github.stevederico.omarchy-displays
```

Enabling loads nothing. The plugin only runs while its window is open.

Local checkout (copy the repository root, not a symlink):

```sh
PLUGIN_ID="io.github.stevederico.omarchy-displays"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"
mkdir -p "$PLUGIN_DIR"
cp -a ~/Projects/omarchy-displays/manifest.json \
  ~/Projects/omarchy-displays/plugin \
  ~/Projects/omarchy-displays/README.md \
  ~/Projects/omarchy-displays/LICENSE \
  "$PLUGIN_DIR/"
omarchy plugin validate "$PLUGIN_DIR"
omarchy plugin enable "$PLUGIN_ID"
```

## Try it safely first

1. Have a way back that needs no screen, like an SSH session:
   `hyprctl reload` restores `monitors.lua`
2. Open in dry run with a scratch file. Apply only shows the plan
3. Reopen without dry run, keep the scratch file, and try a small move.
   Let the countdown expire once, press Revert once
4. Keep, then compare the scratch file with your real one
5. Only then use it without `monitorsFile`

## Use

```sh
omarchy-shell shell summon io.github.stevederico.omarchy-displays
```

Dry run. Apply shows the plan and changes nothing:

```sh
omarchy-shell shell summon io.github.stevederico.omarchy-displays '{"dryRun":true}'
```

Save to a scratch file instead of the real `monitors.lua`:

```sh
cp ~/.config/hypr/monitors.lua /tmp/monitors-try.lua
omarchy-shell shell summon io.github.stevederico.omarchy-displays \
  '{"monitorsFile":"/tmp/monitors-try.lua"}'
```

Print the current plan from a terminal while the window is open:

```sh
omarchy-shell shell call io.github.stevederico.omarchy-displays planText ''
```

| Control | Action |
|---------|--------|
| Drag a display | Move it. It snaps to the nearest free edge |
| Click a display | Select it for the settings below |
| Left of / Right of / Above / Below | Place the selected display beside another |
| Reset | Back to the arrangement that is live now |
| Preview | Show the exact Lua without applying |
| Apply | Apply live and start the 15-second countdown |
| Return | Keep, while the countdown runs |
| Esc | Revert while the countdown runs, otherwise close |

## Optional integrations

To add a **Setup → Displays** menu row, merge the `setup.displays` object from
`extra/omarchy-menu-displays.jsonc` into your existing
`~/.config/omarchy/extensions/omarchy-menu.jsonc`. Do not replace that file.

To add an application-launcher entry:

```sh
cp extra/sd.displays.desktop ~/.local/share/applications/
```

To float the window instead of tiling it, merge
`extra/omarchy-displays-window.lua` into `~/.config/hypr/hyprland.lua`.

The window opens on the active workspace of the focused monitor, like any
new window. If it lands somewhere else, a hook in your Hyprland config is
moving new windows off that workspace. The same file has an
`is_displays_window(win)` check to skip it there.

## Undo a saved arrangement

Delete the `omarchy-displays` block from `~/.config/hypr/monitors.lua`, or
restore a backup:

```sh
ls ~/.config/hypr/monitors.lua.bak.*
cp ~/.config/hypr/monitors.lua.bak.<unix time> ~/.config/hypr/monitors.lua
```

Hyprland reloads on save.

## Remove

```sh
PLUGIN_ID="io.github.stevederico.omarchy-displays"
omarchy-shell shell hide "$PLUGIN_ID"
omarchy plugin disable "$PLUGIN_ID"
omarchy plugin remove "$PLUGIN_ID"
```

If installed, manually remove the optional menu object, desktop file, window
rule, and the managed block in `monitors.lua`.

## Development checks

```sh
node --test tests/test_displays.js
omarchy plugin validate .
```

The tests never talk to Hyprland. Every script that would call `hyprctl` is
run against a stub that only records its arguments, and every file write
happens in a temp folder.

`qmllint` needs an import path where the shell is reachable as `qs`:

```sh
mkdir -p /tmp/qs-lint && ln -sfn "$OMARCHY_PATH/shell" /tmp/qs-lint/qs
/usr/lib/qt6/bin/qmllint -I /tmp/qs-lint -I "$OMARCHY_PATH/shell" \
  plugin/sd.displays/run/Displays.qml
```

The tests exercise the same `plugin/sd.displays/run/DisplaysLogic.js` module
the window imports. `tests/fixtures/` holds a `hyprctl monitors all -j`
capture (serial numbers replaced) and a `monitors.lua`.

## License

MIT
