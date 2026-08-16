// Generated from the pinned official Omarchy Quattro source.
// Run: node browser-edition/generate-source-pack.mjs
export const QUATTRO_SOURCE_PACK = Object.freeze({
  "schemaVersion": 1,
  "identity": {
    "repository": "https://github.com/basecamp/omarchy",
    "channel": "quattro",
    "version": "4.0.0.alpha",
    "commit": "f0020448ca87329199de7cb12f2015ebc4a3e5e7",
    "tree": "19fba2114c162be330337f8a7f1e109e2a1f8384",
    "normalizedTreeSha256": "7c053841c0b43df796cb002441f3e0cccad4a32288769f499c86b509b4f86980"
  },
  "sources": {
    "default/omarchy/omarchy-menu.jsonc": "53b4599eb1f28fc115ec17a4f7ef59f727d84f2a81c0a0f45960e4b5182a2809",
    "default/hypr/bindings.lua": "7ada30a9a70254c40234efdf41074d1f008c179d92242aacec98f48b132e2dde",
    "default/hypr/bindings/applications.lua": "b5d09ffb52a2d1688c7231d640b06c0e0da05095a0298aff5b8d91d2e5437373",
    "default/hypr/bindings/tiling.lua": "85aac24c8a44fc3d0513e77ac2c59eefb179228834d6670ec76fb310d9f99aaf",
    "default/hypr/bindings/utilities.lua": "60b4ad67084d71222f04b118d6b5df0da7bc7b48169655674b84ae6d2f36b5ff",
    "shell/shell.qml": "9f1db77dcc3c111ceccc860ac472d19b35d385958a63d270ea51e413ab86f1f0",
    "shell/plugins/bar/Bar.qml": "8bbe27ad7c617da1a3770fd5731b8cc79935ac34f04873c3933f7ff581a7cb15",
    "themes/catppuccin/colors.toml": "a7eddcf3342ee0bee5df5ed7aad71c0e8c07ba5549bba7e040064fc5abc09eea",
    "themes/gruvbox/colors.toml": "dc30923fe0f19220ff8087f7830c3e7aa5760829b7f2d2f9a10cadc17e02abe0",
    "themes/matte-black/colors.toml": "71437ba25539371740722baa01de9ffde2dd2d5f35d448a7432ab51adb248c5a",
    "themes/rose-pine/colors.toml": "c9d45f2434edc45520d9a05765b88d42d3053796b6531b4be3d6cc34d2839ae1",
    "themes/tokyo-night/colors.toml": "8b5f53ba35b9305aafa72776dd56ea2029faaf29015e2e42db5e19ef698a8e0e",
    "themes/white/colors.toml": "fd1ed111b8fb919bee5f497416b810405927a7c3c1992571513956b1a53795b3"
  },
  "rootMenu": [
    {
      "id": "apps",
      "icon": "󰀻",
      "label": "Apps"
    },
    {
      "id": "learn",
      "icon": "󰧑",
      "label": "Learn"
    },
    {
      "id": "trigger",
      "icon": "󱓞",
      "label": "Trigger"
    },
    {
      "id": "style",
      "icon": "",
      "label": "Style"
    },
    {
      "id": "setup",
      "icon": "",
      "label": "Setup"
    },
    {
      "id": "install",
      "icon": "󰉉",
      "label": "Install"
    },
    {
      "id": "remove",
      "icon": "󰭌",
      "label": "Remove"
    },
    {
      "id": "update",
      "icon": "",
      "label": "Update"
    },
    {
      "id": "about",
      "icon": "",
      "label": "About",
      "action": "omarchy-launch-about"
    },
    {
      "id": "system",
      "icon": "",
      "label": "System"
    }
  ],
  "bindings": [
    {
      "keys": "SUPER + RETURN",
      "label": "Terminal",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + RETURN",
      "label": "Browser",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + F",
      "label": "File manager",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + ALT + SHIFT + F",
      "label": "File manager (cwd)",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + B",
      "label": "Browser",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + B",
      "label": "Browser (private)",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + N",
      "label": "Editor",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + ALT + RETURN",
      "label": "Tmux",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + CTRL + RETURN",
      "label": "Herdr",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + M",
      "label": "Music",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + M",
      "label": "Music TUI",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + D",
      "label": "Docker",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + G",
      "label": "Signal",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + O",
      "label": "Obsidian",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + W",
      "label": "Omawrite",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + SLASH",
      "label": "Passwords",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + A",
      "label": "ChatGPT",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + A",
      "label": "Grok",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + C",
      "label": "Calendar",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + E",
      "label": "Email",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + E",
      "label": "New email",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + Y",
      "label": "YouTube",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + G",
      "label": "WhatsApp",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + CTRL + G",
      "label": "Google Messages",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + P",
      "label": "Google Photos",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + S",
      "label": "Google Maps",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + X",
      "label": "X",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + X",
      "label": "X Post",
      "source": "default/hypr/bindings/applications.lua"
    },
    {
      "keys": "SUPER + W",
      "label": "Close window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "CTRL + ALT + DELETE",
      "label": "Close all windows",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + J",
      "label": "Toggle window split",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + P",
      "label": "Pseudo window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + T",
      "label": "Toggle window floating/tiling",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + F",
      "label": "Full screen",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + F",
      "label": "Tiled full screen",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + F",
      "label": "Full width",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + O",
      "label": "Pop window out (float & pin)",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + Home",
      "label": "Save window width",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + Home",
      "label": "Restore window width",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + L",
      "label": "Toggle workspace layout",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + LEFT",
      "label": "Focus on left window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + RIGHT",
      "label": "Focus on right window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + UP",
      "label": "Focus on above window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + DOWN",
      "label": "Focus on below window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + S",
      "label": "Toggle scratchpad",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + S",
      "label": "Move window to scratchpad",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + TAB",
      "label": "Next workspace",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + TAB",
      "label": "Previous workspace",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + TAB",
      "label": "Former workspace",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + LEFT",
      "label": "Move workspace to left monitor",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + RIGHT",
      "label": "Move workspace to right monitor",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + UP",
      "label": "Move workspace to up monitor",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + DOWN",
      "label": "Move workspace to down monitor",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + LEFT",
      "label": "Swap window to the left",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + RIGHT",
      "label": "Swap window to the right",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + UP",
      "label": "Swap window up",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + DOWN",
      "label": "Swap window down",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "ALT + TAB",
      "label": "Focus on next window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "ALT + SHIFT + TAB",
      "label": "Focus on previous window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "CTRL + ALT + TAB",
      "label": "Focus on next monitor",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "CTRL + ALT + SHIFT + TAB",
      "label": "Focus on previous monitor",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + code:20",
      "label": "Expand window left",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + code:21",
      "label": "Shrink window left",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + code:20",
      "label": "Shrink window up",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + code:21",
      "label": "Expand window down",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + code:20",
      "label": "Expand window left a little",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + code:21",
      "label": "Shrink window left a little",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + code:20",
      "label": "Shrink window up a little",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + code:21",
      "label": "Expand window down a little",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + code:20",
      "label": "Expand window left a lot",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + code:21",
      "label": "Shrink window left a lot",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + SHIFT + code:20",
      "label": "Shrink window up a lot",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + SHIFT + code:21",
      "label": "Expand window down a lot",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + mouse_down",
      "label": "Scroll active workspace forward",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + mouse_up",
      "label": "Scroll active workspace backward",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + mouse:272",
      "label": "Move window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + mouse:273",
      "label": "Resize window",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + G",
      "label": "Toggle window grouping",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + G",
      "label": "Move active window out of group",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + LEFT",
      "label": "Move window to group on left",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + RIGHT",
      "label": "Move window to group on right",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + UP",
      "label": "Move window to group on top",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + DOWN",
      "label": "Move window to group on bottom",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + TAB",
      "label": "Next window in group",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + SHIFT + TAB",
      "label": "Previous window in group",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + LEFT",
      "label": "Move grouped window focus left",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + CTRL + RIGHT",
      "label": "Move grouped window focus right",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + mouse_down",
      "label": "Next window in group",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + mouse_up",
      "label": "Previous window in group",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SLASH",
      "label": "Monitor scaling up",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + ALT + SLASH",
      "label": "Monitor scaling down",
      "source": "default/hypr/bindings/tiling.lua"
    },
    {
      "keys": "SUPER + SPACE",
      "label": "Omarchy menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + ALT + SPACE",
      "label": "Apps menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + E",
      "label": "Emojis",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + C",
      "label": "Capture menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + O",
      "label": "Toggle menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + H",
      "label": "Hardware menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + code:201",
      "label": "Omarchy menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + ESCAPE",
      "label": "System menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "XF86PowerOff",
      "label": "Power menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + K",
      "label": "Keybindings",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + ALT + K",
      "label": "Tmux keybindings",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + K",
      "label": "Herdr keybindings",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + Q",
      "label": "Calculator",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "XF86Calculator",
      "label": "Calculator",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + SPACE",
      "label": "Background switcher",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + CTRL + SPACE",
      "label": "Theme menu",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + BACKSPACE",
      "label": "Toggle window transparency",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + BACKSPACE",
      "label": "Toggle window gaps",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + BACKSPACE",
      "label": "Toggle single-window square aspect",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + comma",
      "label": "Dismiss last notification",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + comma",
      "label": "Dismiss all notifications",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + ALT + comma",
      "label": "Invoke last notification",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + ALT + comma",
      "label": "Open notification history",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + Delete",
      "label": "Toggle laptop display",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + Delete",
      "label": "Toggle laptop display mirroring",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "PRINT",
      "label": "Screenshot",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "ALT + PRINT",
      "label": "Screenrecording",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + ALT + code:34",
      "label": "Make webcam overlay smaller",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + ALT + code:35",
      "label": "Make webcam overlay larger",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + PRINT",
      "label": "Color picker",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + PRINT",
      "label": "Extract text (OCR) from screenshot",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + S",
      "label": "Share",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + PERIOD",
      "label": "Transcode",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + R",
      "label": "Set reminder",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + R",
      "label": "Show reminders",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + CTRL + R",
      "label": "Clear reminders",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + T",
      "label": "Show time",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + B",
      "label": "Show battery remaining",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + W",
      "label": "Toggle weather",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + SHIFT + CTRL + A",
      "label": "Agent",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + A",
      "label": "Audio",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + B",
      "label": "Bluetooth",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + D",
      "label": "Display",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + D",
      "label": "Calendar",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + W",
      "label": "Network",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + P",
      "label": "Power",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + T",
      "label": "Activity",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + Z",
      "label": "Zoom in",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + ALT + Z",
      "label": "Reset zoom",
      "source": "default/hypr/bindings/utilities.lua"
    },
    {
      "keys": "SUPER + CTRL + L",
      "label": "Lock system",
      "source": "default/hypr/bindings/utilities.lua"
    }
  ],
  "themes": {
    "catppuccin": {
      "label": "Catppuccin",
      "accent": "#89b4fa",
      "selection": "#45475a",
      "muted": "#585b70",
      "background": "#1e1e2e",
      "darkBackground": "#161622",
      "darkerBackground": "#101019",
      "lighterBackground": "#313244",
      "foreground": "#cdd6f4",
      "darkForeground": "#6c7086",
      "brightForeground": "#cdd6f4",
      "red": "#f38ba8",
      "yellow": "#f9e2af",
      "green": "#a6e3a1",
      "cyan": "#94e2d5",
      "blue": "#89b4fa",
      "magenta": "#f5c2e7"
    },
    "gruvbox": {
      "label": "Gruvbox",
      "accent": "#7daea3",
      "selection": "#504945",
      "muted": "#665c54",
      "background": "#282828",
      "darkBackground": "#1e1e1e",
      "darkerBackground": "#161616",
      "lighterBackground": "#3c3836",
      "foreground": "#d4be98",
      "darkForeground": "#7c6f64",
      "brightForeground": "#d4be98",
      "red": "#ea6962",
      "yellow": "#d8a657",
      "green": "#a9b665",
      "cyan": "#89b482",
      "blue": "#7daea3",
      "magenta": "#d3869b"
    },
    "matte-black": {
      "label": "Matte Black",
      "accent": "#e68e0d",
      "selection": "#2a2a2a",
      "muted": "#333333",
      "background": "#121212",
      "darkBackground": "#0d0d0d",
      "darkerBackground": "#090909",
      "lighterBackground": "#1e1e1e",
      "foreground": "#bebebe",
      "darkForeground": "#555555",
      "brightForeground": "#bebebe",
      "red": "#D35F5F",
      "yellow": "#b91c1c",
      "green": "#FFC107",
      "cyan": "#bebebe",
      "blue": "#e68e0d",
      "magenta": "#D35F5F"
    },
    "rose-pine": {
      "label": "Rose Pine",
      "accent": "#56949f",
      "selection": "#dfdad9",
      "muted": "#cecacd",
      "background": "#faf4ed",
      "darkBackground": "#ede7e1",
      "darkerBackground": "#e1dbd5",
      "lighterBackground": "#f2e9e1",
      "foreground": "#575279",
      "darkForeground": "#9893a5",
      "brightForeground": "#575279",
      "red": "#b4637a",
      "yellow": "#ea9d34",
      "green": "#286983",
      "cyan": "#d7827e",
      "blue": "#56949f",
      "magenta": "#907aa9"
    },
    "tokyo-night": {
      "label": "Tokyo Night",
      "accent": "#7aa2f7",
      "selection": "#292e42",
      "muted": "#414868",
      "background": "#1a1b26",
      "darkBackground": "#13141c",
      "darkerBackground": "#0e0e14",
      "lighterBackground": "#24283b",
      "foreground": "#a9b1d6",
      "darkForeground": "#565f89",
      "brightForeground": "#c0caf5",
      "red": "#f7768e",
      "yellow": "#e0af68",
      "green": "#9ece6a",
      "cyan": "#449dab",
      "blue": "#7aa2f7",
      "magenta": "#ad8ee6"
    },
    "white": {
      "label": "White",
      "accent": "#6e6e6e",
      "selection": "#c0c0c0",
      "muted": "#808080",
      "background": "#ffffff",
      "darkBackground": "#f5f5f5",
      "darkerBackground": "#e8e8e8",
      "lighterBackground": "#c0c0c0",
      "foreground": "#000000",
      "darkForeground": "#c0c0c0",
      "brightForeground": "#000000",
      "red": "#2a2a2a",
      "yellow": "#4a4a4a",
      "green": "#3a3a3a",
      "cyan": "#3e3e3e",
      "blue": "#1a1a1a",
      "magenta": "#2e2e2e"
    }
  }
});
