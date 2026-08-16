-- BEGIN OMARCHY X86 WEB LOOK-AND-FEEL PRELOAD
-- Hyprland's default Quattro look-and-feel performs many separate Lua bridge
-- calls. Under browser x86 emulation those calls can exceed Hyprland's bounded
-- configuration-reload budget. Keep the authentic module installed unchanged,
-- but preload one web-optimized equivalent for this disposable x86 profile.
package.preload["default.hypr.looknfeel"] = function()
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
    group = {
      col = {
        border_active = active_border_color,
        border_inactive = inactive_border_color,
      },
      groupbar = {
        font_size = 12,
        font_family = "monospace",
        font_weight_active = "ultraheavy",
        font_weight_inactive = "normal",
        indicator_height = 1,
        indicator_gap = 5,
        height = 22,
        gaps_in = 5,
        gaps_out = 0,
        text_color = "rgb(ffffff)",
        text_color_inactive = "rgba(ffffff90)",
        col = {
          active = "rgba(00000040)",
          inactive = "rgba(00000020)",
        },
        gradients = false,
        gradient_rounding = 0,
        gradient_round_only_edges = false,
      },
    },
    animations = { enabled = false },
    dwindle = {
      preserve_split = true,
      force_split = 2,
    },
    scrolling = { column_width = 0.49 },
    master = { new_status = "master" },
    misc = {
      disable_hyprland_logo = true,
      disable_splash_rendering = true,
      disable_scale_notification = true,
      focus_on_activate = true,
      anr_missed_pings = 3,
      on_focus_under_fullscreen = 1,
      initial_workspace_tracking = 0,
      allow_session_lock_restore = true,
    },
    cursor = {
      hide_on_key_press = true,
      warp_on_change_workspace = 1,
    },
    binds = { hide_special_on_workspace_change = true },
  })
end
-- END OMARCHY X86 WEB LOOK-AND-FEEL PRELOAD
