-- Omarchy Quattro's bounded x86 browser profile.
--
-- The authentic default and user configs remain installed under
-- /usr/share/omarchy. This disposable user config keeps the real Omarchy shell,
-- theme, commands, tiling model, and primary shortcuts while avoiding hundreds
-- of Lua-to-compositor calls for physical hardware and apps not shipped here.

dofile((os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/default/hypr/bootstrap.lua")

local active_border_color = { colors = { "rgba(33ccffee)", "rgba(00ff99ee)" }, angle = 45 }
local inactive_border_color = "rgba(595959aa)"

hl.config({
  general = {
    gaps_in = 5,
    gaps_out = 10,
    border_size = 2,
    col = {
      active_border = active_border_color,
      inactive_border = inactive_border_color,
    },
    resize_on_border = false,
    allow_tearing = false,
    layout = "dwindle",
  },
  decoration = {
    rounding = 0,
    shadow = { enabled = false },
    blur = { enabled = false },
  },
  animations = { enabled = false },
  dwindle = {
    preserve_split = true,
    force_split = 2,
  },
  input = {
    kb_layout = "us",
    kb_variant = "",
    kb_model = "",
    kb_options = "compose:caps,shift:both_capslock_cancel",
    kb_rules = "",
    follow_mouse = 1,
    sensitivity = 0,
    repeat_rate = 40,
    repeat_delay = 250,
    numlock_by_default = true,
    touchpad = {
      natural_scroll = false,
      clickfinger_behavior = true,
      scroll_factor = 0.4,
    },
  },
  misc = {
    disable_hyprland_logo = true,
    disable_splash_rendering = true,
    disable_scale_notification = true,
    focus_on_activate = true,
    key_press_enables_dpms = true,
    mouse_move_enables_dpms = true,
    anr_missed_pings = 3,
    on_focus_under_fullscreen = 1,
    initial_workspace_tracking = 0,
    allow_session_lock_restore = true,
  },
  cursor = {
    hide_on_key_press = true,
    warp_on_change_workspace = 1,
  },
  xwayland = { force_zero_scaling = true },
  ecosystem = { no_update_news = true },
})

hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")
hl.env("XDG_CURRENT_DESKTOP", "Hyprland")
hl.env("XDG_SESSION_DESKTOP", "Hyprland")

-- The source file remains authentic and the appended virtual-monitor profile
-- keeps the browser canvas pixel-for-pixel at scale 1.
require("hypr.monitors")

hl.bind("SUPER + RETURN", hl.dsp.exec_cmd("omarchy-launch-terminal"), { description = "Terminal" })
hl.bind("SUPER + SHIFT + RETURN", hl.dsp.exec_cmd("omarchy-launch-browser"), { description = "Browser" })
hl.bind("SUPER + SPACE", hl.dsp.exec_cmd("omarchy-menu toggle"), { description = "Omarchy menu" })
hl.bind("SUPER + W", hl.dsp.window.close(), { description = "Close window" })
hl.bind("SUPER + F", hl.dsp.window.fullscreen({ mode = "fullscreen" }), { description = "Full screen" })
hl.bind("SUPER + T", hl.dsp.window.float({ action = "toggle" }), { description = "Toggle floating" })
hl.bind("SUPER + LEFT", hl.dsp.focus({ direction = "l" }), { description = "Focus left" })
hl.bind("SUPER + RIGHT", hl.dsp.focus({ direction = "r" }), { description = "Focus right" })
hl.bind("SUPER + UP", hl.dsp.focus({ direction = "u" }), { description = "Focus up" })
hl.bind("SUPER + DOWN", hl.dsp.focus({ direction = "d" }), { description = "Focus down" })
hl.bind("SUPER + mouse:272", hl.dsp.window.drag(), { description = "Move window", mouse = true })
hl.bind("SUPER + mouse:273", hl.dsp.window.resize(), { description = "Resize window", mouse = true })

for workspace = 1, 4 do
  local key = "code:" .. tostring(workspace + 9)
  hl.bind(
    "SUPER + " .. key,
    hl.dsp.focus({ workspace = tostring(workspace) }),
    { description = "Switch to workspace " .. workspace }
  )
  hl.bind(
    "SUPER + SHIFT + " .. key,
    hl.dsp.window.move({ workspace = tostring(workspace) }),
    { description = "Move window to workspace " .. workspace }
  )
end

hl.on("hyprland.start", function()
  hl.exec_cmd("systemctl --user import-environment $(env | cut -d'=' -f 1)")
  hl.exec_cmd("dbus-update-activation-environment --systemd --all")
  hl.exec_cmd("omarchy-launch-shell")
  hl.exec_cmd("omarchy-provision-first-run")
  hl.exec_cmd("sleep 2 && omarchy-hook post-boot")
end)

-- Retain the web welcome hook appended to Quattro's user autostart file.
require("hypr.autostart")
