on run arguments
  set mountPath to item 1 of arguments
  set appName to item 2 of arguments
  set mountedFolder to POSIX file mountPath as alias
  tell application "Finder"
    open mountedFolder
    delay 1
    set installerWindow to front Finder window
    set installerFolder to target of installerWindow
    if POSIX path of (installerFolder as alias) is not mountPath & "/" then
      error "Finder opened an unexpected folder while arranging the DMG"
    end if
    tell installerWindow
      set current view of installerWindow to icon view
      set toolbar visible of installerWindow to false
      set statusbar visible of installerWindow to false
      set pathbar visible of installerWindow to false
      set sidebar width of installerWindow to 0
      set bounds of installerWindow to {100, 100, 740, 540}

      set iconOptions to the icon view options of installerWindow
      set arrangement of iconOptions to not arranged
      set icon size of iconOptions to 128
      set text size of iconOptions to 14
      set shows icon preview of iconOptions to false

      set position of item appName of installerFolder to {180, 190}
      set position of item "Applications" of installerFolder to {460, 190}
    end tell
    update installerFolder without registering applications
    delay 2
    close installerWindow
  end tell
end run
