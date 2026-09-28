-- Optional. Float the Displays window instead of tiling it.
-- Merge into ~/.config/hypr/hyprland.lua. Do not replace that file.
o.window({ class = "^org.quickshell$", title = "^Displays$" }, {
  float = true,
  center = true,
  size = { 900, 760 },
})
