-- Browser-VM hardware override. This is the only monitor delta from the
-- pinned Omarchy config and makes the QEMU EDID mode deterministic.
local omarchy_gdk_scale = 1

hl.env("GDK_SCALE", tostring(omarchy_gdk_scale))
hl.monitor({ output = "", mode = "1600x900@60", position = "0x0", scale = 1 })
