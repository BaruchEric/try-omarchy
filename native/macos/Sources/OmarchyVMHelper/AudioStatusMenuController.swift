import AppKit
import AVFoundation
import Foundation

private final class AudioMenuSelectionAction: NSObject {
    let direction: HostAudioDirection
    let selection: AudioRouteSelection

    init(direction: HostAudioDirection, selection: AudioRouteSelection) {
        self.direction = direction
        self.selection = selection
    }
}

final class AudioStatusMenuController: NSObject, NSMenuDelegate {
    typealias RestartHandler = () -> Bool
    typealias QuitHandler = () -> Void

    private let preferenceStore: AudioRoutingPreferenceStore
    private let deviceProvider: HostAudioDeviceProviding
    private let restartAllowed: Bool
    private let onRestart: RestartHandler
    private let onQuit: QuitHandler
    private let statusItem: NSStatusItem
    private let menu = NSMenu()

    private var runningRoutes: ResolvedAudioRoutes
    private var restarting = false

    init(
        preferenceStore: AudioRoutingPreferenceStore,
        deviceProvider: HostAudioDeviceProviding,
        runningRoutes: ResolvedAudioRoutes,
        restartAllowed: Bool,
        onRestart: @escaping RestartHandler,
        onQuit: @escaping QuitHandler
    ) {
        self.preferenceStore = preferenceStore
        self.deviceProvider = deviceProvider
        self.runningRoutes = runningRoutes
        self.restartAllowed = restartAllowed
        self.onRestart = onRestart
        self.onQuit = onQuit
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.setAccessibilityLabel("Omarchy audio devices")
        rebuildMenu()
    }

    func setRunningRoutes(_ routes: ResolvedAudioRoutes) {
        runningRoutes = routes
        restarting = false
        updateStatusPresentation()
    }

    func setRestarting(_ restarting: Bool) {
        self.restarting = restarting
        updateStatusPresentation()
    }

    func invalidate() {
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    func menuWillOpen(_ menu: NSMenu) {
        rebuildMenu()
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        let preferences = preferenceStore.load()
        let catalog = deviceProvider.catalog()
        let desiredRoutes = AudioLaunchConfiguration.make(
            baseEnvironment: [:],
            preferences: preferences,
            catalog: catalog
        ).routes
        let hasPendingChanges = desiredRoutes != runningRoutes

        let speaker = NSMenuItem(title: "Speaker", action: nil, keyEquivalent: "")
        speaker.image = NSImage(systemSymbolName: "speaker.wave.2", accessibilityDescription: nil)
        speaker.submenu = routeMenu(
            direction: .output,
            selection: preferences.output,
            catalog: catalog
        )
        menu.addItem(speaker)

        let microphone = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        microphone.image = NSImage(systemSymbolName: "mic", accessibilityDescription: nil)
        microphone.submenu = routeMenu(
            direction: .input,
            selection: preferences.input,
            catalog: catalog
        )
        menu.addItem(microphone)
        menu.addItem(.separator())

        if hasPendingChanges {
            let explanation: String
            if restartAllowed {
                explanation = "Audio changes apply after restart."
            } else {
                explanation = "Audio changes apply when this disposable VM is reopened."
            }
            menu.addItem(disabledItem(explanation))
        }

        let restart = NSMenuItem(
            title: "Restart Omarchy to Apply",
            action: #selector(restartToApply),
            keyEquivalent: ""
        )
        restart.target = self
        restart.image = NSImage(
            systemSymbolName: "arrow.triangle.2.circlepath",
            accessibilityDescription: nil
        )
        restart.isEnabled = hasPendingChanges && restartAllowed && !restarting
        menu.addItem(restart)

        if hasPendingChanges && !restartAllowed {
            menu.addItem(disabledItem("Restart is unavailable for a disposable VM."))
        } else if restarting {
            menu.addItem(disabledItem("Restarting Omarchy…"))
        }

        menu.addItem(.separator())
        let microphoneStatus = NSMenuItem(
            title: "Microphone Access: \(Self.microphoneAuthorizationLabel())",
            action: nil,
            keyEquivalent: ""
        )
        microphoneStatus.isEnabled = false
        menu.addItem(microphoneStatus)

        let soundSettings = NSMenuItem(
            title: "Open Sound Settings…",
            action: #selector(openSoundSettings),
            keyEquivalent: ""
        )
        soundSettings.target = self
        menu.addItem(soundSettings)

        let microphoneSettings = NSMenuItem(
            title: "Open Microphone Privacy Settings…",
            action: #selector(openMicrophoneSettings),
            keyEquivalent: ""
        )
        microphoneSettings.target = self
        menu.addItem(microphoneSettings)

        menu.addItem(.separator())
        let quit = NSMenuItem(
            title: "Quit Omarchy",
            action: #selector(quitOmarchy),
            keyEquivalent: "q"
        )
        quit.target = self
        menu.addItem(quit)

        updateStatusPresentation(
            hasPendingChanges: hasPendingChanges,
            desiredRoutes: desiredRoutes
        )
    }

    private func routeMenu(
        direction: HostAudioDirection,
        selection: AudioRouteSelection,
        catalog: HostAudioDeviceCatalog
    ) -> NSMenu {
        let submenu = NSMenu()

        // This must stay the first item in each submenu: it represents a live
        // relationship to macOS's default route, not today's default UID.
        let systemDefault = routeItem(
            title: "System Default",
            direction: direction,
            selection: .systemDefault
        )
        if selection == .systemDefault { systemDefault.state = .on }
        submenu.addItem(systemDefault)
        submenu.addItem(.separator())

        let devices = catalog.devices(for: direction)
        if case .device(let selectedUID, let lastKnownName) = selection,
           catalog.device(uid: selectedUID, direction: direction) == nil {
            let unavailable = disabledItem(
                "\(lastKnownName) (Unavailable — using System Default)"
            )
            unavailable.state = .on
            submenu.addItem(unavailable)
        }

        for device in devices {
            let item = routeItem(
                title: device.sdlName,
                direction: direction,
                selection: .device(uid: device.uid, lastKnownName: device.sdlName)
            )
            if selection.deviceUID == device.uid { item.state = .on }
            submenu.addItem(item)
        }

        if devices.isEmpty {
            submenu.addItem(disabledItem(
                direction == .output ? "No speakers found" : "No microphones found"
            ))
        }
        return submenu
    }

    private func routeItem(
        title: String,
        direction: HostAudioDirection,
        selection: AudioRouteSelection
    ) -> NSMenuItem {
        let item = NSMenuItem(
            title: title,
            action: #selector(selectAudioRoute(_:)),
            keyEquivalent: ""
        )
        item.target = self
        item.representedObject = AudioMenuSelectionAction(
            direction: direction,
            selection: selection
        )
        return item
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func selectAudioRoute(_ sender: NSMenuItem) {
        guard let choice = sender.representedObject as? AudioMenuSelectionAction else { return }
        preferenceStore.set(choice.selection, for: choice.direction)
        updateStatusPresentation()
    }

    @objc private func restartToApply() {
        guard restartAllowed, !restarting, hasPendingChanges() else { return }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Restart Omarchy to apply audio changes?"
        alert.informativeText = "Save work inside Omarchy first. Restarting closes the running VM and cold-boots it again."
        alert.addButton(withTitle: "Restart Omarchy")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        if onRestart() {
            restarting = true
            updateStatusPresentation()
        }
    }

    @objc private func openSoundSettings() {
        Self.openSettings(
            "x-apple.systempreferences:com.apple.Sound-Settings.extension",
            fallback: "x-apple.systempreferences:"
        )
    }

    @objc private func openMicrophoneSettings() {
        Self.openSettings(
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
            fallback: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        )
    }

    @objc private func quitOmarchy() {
        onQuit()
    }

    private func hasPendingChanges() -> Bool {
        let preferences = preferenceStore.load()
        let catalog = deviceProvider.catalog()
        let desiredRoutes = AudioLaunchConfiguration.make(
            baseEnvironment: [:],
            preferences: preferences,
            catalog: catalog
        ).routes
        return desiredRoutes != runningRoutes
    }

    private func updateStatusPresentation() {
        let preferences = preferenceStore.load()
        let catalog = deviceProvider.catalog()
        let desiredRoutes = AudioLaunchConfiguration.make(
            baseEnvironment: [:],
            preferences: preferences,
            catalog: catalog
        ).routes
        updateStatusPresentation(
            hasPendingChanges: desiredRoutes != runningRoutes,
            desiredRoutes: desiredRoutes
        )
    }

    private func updateStatusPresentation(
        hasPendingChanges: Bool,
        desiredRoutes: ResolvedAudioRoutes
    ) {
        let symbolName: String
        let toolTip: String
        if restarting {
            symbolName = "arrow.triangle.2.circlepath"
            toolTip = "Restarting Omarchy to apply audio changes"
        } else if hasPendingChanges {
            symbolName = "speaker.badge.exclamationmark"
            toolTip = restartAllowed
                ? "Audio change saved — restart Omarchy to apply"
                : "Audio change saved — reopen the disposable VM to apply"
        } else {
            symbolName = "speaker.wave.2"
            toolTip = "Omarchy audio devices"
        }

        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: toolTip)
            ?? NSImage(systemSymbolName: "speaker.wave.2", accessibilityDescription: toolTip)
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = toolTip
        _ = desiredRoutes // Keeps call sites explicit about the compared snapshot.
    }

    private static func microphoneAuthorizationLabel() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: "Allowed"
        case .denied: "Denied"
        case .restricted: "Restricted"
        case .notDetermined: "Not Requested"
        @unknown default: "Restricted"
        }
    }

    private static func openSettings(_ primary: String, fallback: String) {
        if let url = URL(string: primary), NSWorkspace.shared.open(url) { return }
        if let url = URL(string: fallback) { NSWorkspace.shared.open(url) }
    }
}
