-- See https://wiki.hypr.land/Configuring/Basics/Monitors/
-- List current monitors and supported resolutions with: hyprctl monitors all

local omarchy_gdk_scale = 1
local omarchy_monitor_scale = "auto"

hl.env("GDK_SCALE", tostring(omarchy_gdk_scale))
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = omarchy_monitor_scale })

-- Match by panel description, so a display keeps its rule when its
-- connector name changes.
local left = "desc:Dell Inc. DELL U2719D"
local right = "desc:Samsung Electric Company U28H75x"

hl.monitor({
  output = left,
  mode = "2560x1440@60",
  position = "0x0",
  scale = 1,
})
hl.monitor({
  output = right,
  mode = "3840x2160@30",
  position = "2560x0",
  scale = 1.5,
})

-- A laptop panel matched by connector name.
hl.monitor({ output = "eDP-1", mode = "preferred", position = "auto", scale = 2 })

-- Portrait/rotated secondary monitor (transform: 1 = 90°, 3 = 270°).
-- hl.monitor({ output = "DP-2", mode = "preferred", position = "auto", scale = 1, transform = 1 })
