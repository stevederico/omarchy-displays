-- Optional. Merge into ~/.config/hypr/hyprland.lua. Do not replace that file.

-- The Displays window, for rules and hooks. The shell maps it like any new
-- window, on the active workspace of the focused monitor.
local function is_displays_window(win)
  local class = win and (win.class or win.initial_class) or ""
  local title = win and (win.title or win.initial_title) or ""
  return class == "org.quickshell" and title == "Displays"
end

-- Float it instead of tiling it.
o.window({ class = "^org.quickshell$", title = "^Displays$" }, {
  float = true,
  center = true,
  size = { 900, 760 },
})

-- If it opens on another workspace, a hook of your own is moving it: one
-- that sends new windows off a workspace moves this one too. Skip it there:
--
--   hl.on("window.open", function(win)
--     if is_displays_window(win) then return end
--     -- your existing move
--   end)
--
-- or add `or is_displays_window(win)` to that hook's early return.
