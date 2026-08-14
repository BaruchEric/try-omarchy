
-- BEGIN OMARCHY WEB VIRTUAL-HARDWARE PROFILE
-- The browser display backend advertises the canvas size as its preferred
-- mode. A scale of 1 keeps that framebuffer pixel-for-pixel sharp.
hl.env("GDK_SCALE", "1")
hl.monitor({ output = "", mode = "preferred", position = "0x0", scale = 1 })
-- END OMARCHY WEB VIRTUAL-HARDWARE PROFILE
