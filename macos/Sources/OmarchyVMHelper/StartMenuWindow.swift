import AppKit

private final class MouseIgnoringTextField: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

@MainActor
final class StartMenuWindow: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private let content = NSView()
    private let accessibilityStatus: () -> Bool
    private let microphoneStatus: () -> MicrophoneAuthorizationState
    private let requestAccessibility: () -> Void
    private let requestMicrophone: (@escaping (Bool) -> Void) -> Void
    private let storageSpaceEstimate: () -> String?
    private let resetStorage: () -> Void
    private let launch: () -> Void
    private let canResetStorage: Bool

    private var microphoneRequestInFlight = false
    private var resetInProgress = false
    private var launchInProgress = false
    private var pendingResetSpaceEstimate: String?

    init(
        accessibilityStatus: @escaping () -> Bool,
        microphoneStatus: @escaping () -> MicrophoneAuthorizationState,
        requestAccessibility: @escaping () -> Void,
        requestMicrophone: @escaping (@escaping (Bool) -> Void) -> Void,
        canResetStorage: Bool,
        storageSpaceEstimate: @escaping () -> String?,
        resetStorage: @escaping () -> Void,
        launch: @escaping () -> Void
    ) {
        self.accessibilityStatus = accessibilityStatus
        self.microphoneStatus = microphoneStatus
        self.requestAccessibility = requestAccessibility
        self.requestMicrophone = requestMicrophone
        self.canResetStorage = canResetStorage
        self.storageSpaceEstimate = storageSpaceEstimate
        self.resetStorage = resetStorage
        self.launch = launch

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 510),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        window.title = "Try Omarchy"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = content
    }

    func show() {
        render()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func refreshPermissionStatus() {
        guard window.isVisible, !launchInProgress, !resetInProgress else { return }
        render()
    }

    func promptForReset() {
        guard canResetStorage else { return }
        window.makeKeyAndOrderFront(nil)
        confirmReset()
    }

    func dismiss() {
        window.orderOut(nil)
    }

    func resetDidFinish(errorMessage: String?) {
        guard resetInProgress else { return }
        resetInProgress = false
        render()

        let alert = NSAlert()
        if let errorMessage {
            alert.alertStyle = .critical
            alert.messageText = "Omarchy couldn’t be reset"
            alert.informativeText = errorMessage
        } else {
            alert.alertStyle = .informational
            alert.messageText = "Omarchy has been reset"
            if let estimate = pendingResetSpaceEstimate {
                alert.informativeText = "The VM is back to factory settings. Up to \(estimate) of disk space was reclaimed. You can launch whenever you’re ready."
            } else {
                alert.informativeText = "The VM is back to factory settings. You can launch whenever you’re ready."
            }
        }
        pendingResetSpaceEstimate = nil
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    func launchRequiresReset() {
        guard launchInProgress else { return }
        launchInProgress = false
        render()

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Reset Omarchy to continue"
        alert.informativeText = "This VM was created by a different Try Omarchy build. Reset Omarchy to use this version. Resetting permanently erases everything in the VM."
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return false
    }

    private func render() {
        content.subviews.forEach { $0.removeFromSuperview() }

        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 62),
            icon.heightAnchor.constraint(equalToConstant: 62),
        ])

        let title = NSTextField(labelWithString: "Try Omarchy")
        title.font = .systemFont(ofSize: 27, weight: .bold)

        let headingStack = NSStackView(views: [icon, title])
        headingStack.orientation = .vertical
        headingStack.alignment = .leading
        headingStack.spacing = 10

        let accessibilityGranted = accessibilityStatus()
        let accessibilityRow = permissionRow(
            symbolName: "accessibility",
            title: "Accessibility",
            detail: "Needed for the native keyboard experience with Super shortcuts.",
            granted: accessibilityGranted,
            actionTitle: accessibilityGranted ? nil : "Open Settings",
            action: #selector(beginAccessibilityRequest)
        )

        let microphoneState = microphoneStatus()
        let microphoneGranted = microphoneState == .authorized
        let microphoneDetail: String
        let microphoneActionTitle: String?
        switch microphoneState {
        case .authorized:
            microphoneDetail = "Apps in Omarchy can record from your Mac microphone."
            microphoneActionTitle = nil
        case .notDetermined:
            microphoneDetail = "Optional. Speaker playback works without microphone access."
            microphoneActionTitle = microphoneRequestInFlight ? "Waiting…" : "Allow…"
        case .denied:
            microphoneDetail = "Recording is off. Speaker playback will still work."
            microphoneActionTitle = "Open Settings"
        case .restricted:
            microphoneDetail = "Recording is unavailable because of this Mac’s policy."
            microphoneActionTitle = nil
        }
        let microphoneRow = permissionRow(
            symbolName: "mic",
            title: "Microphone access",
            detail: microphoneDetail,
            granted: microphoneGranted,
            actionTitle: microphoneActionTitle,
            action: microphoneState == .denied
                ? #selector(openMicrophoneSettings)
                : #selector(beginMicrophoneRequest)
        )

        let permissionRows = NSStackView(views: [accessibilityRow, separator(), microphoneRow])
        permissionRows.orientation = .vertical
        permissionRows.alignment = .width
        permissionRows.spacing = 0
        permissionRows.translatesAutoresizingMaskIntoConstraints = false

        let permissionCard = NSView()
        permissionCard.wantsLayer = true
        permissionCard.layer?.cornerRadius = 12
        permissionCard.layer?.borderWidth = 1
        permissionCard.layer?.borderColor = NSColor.separatorColor.cgColor
        permissionCard.addSubview(permissionRows)
        NSLayoutConstraint.activate([
            permissionRows.leadingAnchor.constraint(equalTo: permissionCard.leadingAnchor, constant: 20),
            permissionRows.trailingAnchor.constraint(equalTo: permissionCard.trailingAnchor, constant: -20),
            permissionRows.topAnchor.constraint(equalTo: permissionCard.topAnchor, constant: 5),
            permissionRows.bottomAnchor.constraint(equalTo: permissionCard.bottomAnchor, constant: -5),
        ])

        let reset = NSButton(
            title: resetInProgress ? "Resetting Omarchy…" : "Reset Omarchy",
            target: self,
            action: #selector(resetOmarchy)
        )
        reset.bezelStyle = .rounded
        reset.controlSize = .small
        reset.contentTintColor = .systemRed
        reset.isEnabled = canResetStorage && !launchInProgress && !resetInProgress
        reset.toolTip = canResetStorage
            ? "Erase this VM and return it to factory settings"
            : "Reset is unavailable for a disposable VM"

        let launchButton = NSButton(
            title: "",
            target: self,
            action: #selector(launchOmarchy)
        )
        launchButton.keyEquivalent = launchInProgress ? "" : "\r"
        launchButton.bezelStyle = .rounded
        launchButton.controlSize = .large
        launchButton.isEnabled = !launchInProgress && !resetInProgress && !microphoneRequestInFlight
        launchButton.translatesAutoresizingMaskIntoConstraints = false
        launchButton.setAccessibilityLabel(launchInProgress ? "Launching Omarchy" : "Launch Omarchy")

        let launchTitle = MouseIgnoringTextField(
            labelWithString: launchInProgress ? "Launching Omarchy…" : "Launch Omarchy"
        )
        launchTitle.font = .systemFont(ofSize: 16, weight: .semibold)
        launchTitle.textColor = .alternateSelectedControlTextColor
        launchTitle.alignment = .center
        launchTitle.translatesAutoresizingMaskIntoConstraints = false
        launchButton.addSubview(launchTitle)
        NSLayoutConstraint.activate([
            launchTitle.centerXAnchor.constraint(equalTo: launchButton.centerXAnchor),
            launchTitle.centerYAnchor.constraint(equalTo: launchButton.centerYAnchor),
        ])
        if launchInProgress {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.translatesAutoresizingMaskIntoConstraints = false
            spinner.startAnimation(nil)
            launchButton.addSubview(spinner)
            NSLayoutConstraint.activate([
                spinner.centerYAnchor.constraint(equalTo: launchButton.centerYAnchor),
                spinner.trailingAnchor.constraint(equalTo: launchButton.trailingAnchor, constant: -16),
            ])
        }
        NSLayoutConstraint.activate([
            launchButton.heightAnchor.constraint(equalToConstant: 48),
            launchButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 500),
        ])

        let footerText = "by Martiano  •  Not affiliated with Omarchy."
        let footerTitle = NSMutableAttributedString(
            string: footerText,
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
        let footerNSString = footerText as NSString
        footerTitle.addAttributes(
            [
                .link: URL(string: "https://x.com/martiano")!,
                .foregroundColor: NSColor.linkColor,
            ],
            range: footerNSString.range(of: "Martiano")
        )
        footerTitle.addAttributes(
            [
                .link: URL(string: "https://omarchy.org")!,
                .foregroundColor: NSColor.linkColor,
            ],
            range: footerNSString.range(of: "Omarchy")
        )

        let footer = NSTextField(labelWithAttributedString: footerTitle)
        footer.isSelectable = true
        footer.allowsEditingTextAttributes = true
        footer.translatesAutoresizingMaskIntoConstraints = false

        let footerContainer = NSView()
        footerContainer.addSubview(footer)
        NSLayoutConstraint.activate([
            footer.centerXAnchor.constraint(equalTo: footerContainer.centerXAnchor),
            footer.topAnchor.constraint(equalTo: footerContainer.topAnchor),
            footer.bottomAnchor.constraint(equalTo: footerContainer.bottomAnchor),
        ])

        let stack = NSStackView(
            views: [headingStack, permissionCard, reset, launchButton, footerContainer]
        )
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.setCustomSpacing(22, after: headingStack)
        stack.setCustomSpacing(12, after: permissionCard)
        stack.setCustomSpacing(20, after: reset)
        stack.setCustomSpacing(10, after: launchButton)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 42),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -42),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 48),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -30),
            permissionCard.widthAnchor.constraint(equalTo: stack.widthAnchor),
            launchButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footerContainer.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func permissionRow(
        symbolName: String,
        title: String,
        detail: String,
        granted: Bool,
        actionTitle: String?,
        action: Selector
    ) -> NSView {
        let symbol = NSImageView()
        symbol.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        symbol.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 19, weight: .medium)
        symbol.contentTintColor = .controlAccentColor
        symbol.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            symbol.widthAnchor.constraint(equalToConstant: 26),
            symbol.heightAnchor.constraint(equalToConstant: 26),
        ])

        let name = NSTextField(labelWithString: title)
        name.font = .systemFont(ofSize: 14, weight: .semibold)

        let explanation = NSTextField(wrappingLabelWithString: detail)
        explanation.font = .systemFont(ofSize: 12)
        explanation.textColor = .secondaryLabelColor
        explanation.maximumNumberOfLines = 2

        let labels = NSStackView(views: [name, explanation])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 3

        let status = NSTextField(labelWithString: granted ? "●  Yes" : "○  No")
        status.font = .systemFont(ofSize: 12, weight: .semibold)
        status.textColor = granted ? .systemGreen : .secondaryLabelColor
        status.alignment = .right
        status.setContentHuggingPriority(.required, for: .horizontal)

        var trailingViews: [NSView] = [status]
        if let actionTitle {
            let button = NSButton(title: actionTitle, target: self, action: action)
            button.controlSize = .small
            button.isEnabled = !microphoneRequestInFlight && !launchInProgress
            trailingViews.append(button)
        }
        let trailing = NSStackView(views: trailingViews)
        trailing.orientation = .vertical
        trailing.alignment = .trailing
        trailing.spacing = 6

        let row = NSStackView(views: [symbol, labels, trailing])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 76),
            trailing.widthAnchor.constraint(equalToConstant: 112),
        ])
        labels.setContentHuggingPriority(.defaultLow, for: .horizontal)
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        trailing.setContentHuggingPriority(.required, for: .horizontal)
        trailing.setContentCompressionResistancePriority(.required, for: .horizontal)
        return row
    }

    private func separator() -> NSView {
        let view = NSBox()
        view.boxType = .separator
        return view
    }

    @objc private func beginAccessibilityRequest() {
        requestAccessibility()
        render()
    }

    @objc private func beginMicrophoneRequest() {
        guard microphoneStatus() == .notDetermined, !microphoneRequestInFlight else { return }
        microphoneRequestInFlight = true
        render()
        requestMicrophone { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.microphoneRequestInFlight = false
                self.render()
                self.window.makeKeyAndOrderFront(nil)
            }
        }
    }

    @objc private func openMicrophoneSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func resetOmarchy() {
        confirmReset()
    }

    private func confirmReset() {
        guard canResetStorage, !launchInProgress, !resetInProgress else { return }
        let estimate = storageSpaceEstimate()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Reset Omarchy to factory settings?"
        var detail = "This permanently erases everything in this Omarchy virtual machine, including apps, files, accounts, and settings. This cannot be undone or recovered."
        if let estimate {
            detail += " Resetting may free up to \(estimate) of disk space."
        }
        alert.informativeText = detail
        alert.addButton(withTitle: "Cancel")
        let resetButton = alert.addButton(withTitle: "Reset")
        resetButton.hasDestructiveAction = true
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        pendingResetSpaceEstimate = estimate
        resetInProgress = true
        render()
        resetStorage()
    }

    @objc private func launchOmarchy() {
        guard !launchInProgress, !resetInProgress else { return }
        launchInProgress = true
        render()
        launch()
    }
}
