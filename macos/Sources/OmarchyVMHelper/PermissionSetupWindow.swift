import AppKit
import AVFoundation

struct PermissionSetupCompletionStore {
    static let completionKey = "permissionSetupCompleted.v1"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isComplete: Bool {
        defaults.bool(forKey: Self.completionKey)
    }

    func markComplete() {
        defaults.set(true, forKey: Self.completionKey)
    }
}

@MainActor
final class PermissionSetupWindow: NSObject, NSWindowDelegate {
    private enum Step {
        case accessibility
        case microphone
    }

    private let window: NSWindow
    private let content = NSView()
    private let accessibilityStatus: () -> Bool
    private let microphoneStatus: () -> MicrophoneAuthorizationState
    private let requestAccessibility: () -> Void
    private let requestMicrophone: (@escaping (Bool) -> Void) -> Void
    private let finish: () -> Void

    private var step = Step.accessibility
    private var accessibilityRequestStarted = false
    private var microphoneRequestInFlight = false
    private var launchInProgress = false

    init(
        accessibilityStatus: @escaping () -> Bool,
        microphoneStatus: @escaping () -> MicrophoneAuthorizationState,
        requestAccessibility: @escaping () -> Void,
        requestMicrophone: @escaping (@escaping (Bool) -> Void) -> Void,
        finish: @escaping () -> Void
    ) {
        self.accessibilityStatus = accessibilityStatus
        self.microphoneStatus = microphoneStatus
        self.requestAccessibility = requestAccessibility
        self.requestMicrophone = requestMicrophone
        self.finish = finish

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 400),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        window.title = "Set up Try Omarchy"
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
        guard window.isVisible else { return }
        render()
    }

    func dismiss() {
        window.orderOut(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return false
    }

    private func render() {
        content.subviews.forEach { $0.removeFromSuperview() }

        let page: NSView
        switch step {
        case .accessibility:
            page = accessibilityPage()
        case .microphone:
            page = microphonePage()
        }
        page.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 42),
            page.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -42),
            page.topAnchor.constraint(equalTo: content.topAnchor, constant: 55),
            page.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -34),
        ])
    }

    private func accessibilityPage() -> NSView {
        let granted = accessibilityStatus()
        let detail: String
        if granted {
            detail = "Accessibility is allowed. Command will work as the Super key while the Omarchy window is focused."
        } else if accessibilityRequestStarted {
            detail = "Complete the change in System Settings. You can continue without it but the system will lack Super commands."
        } else {
            detail = "Accessibility lets Try Omarchy use the Mac Command key as Omarchy’s Super key. Only used while Try Omarchy is open and focused."
        }

        let primary = NSButton(
            title: granted || accessibilityRequestStarted ? "Continue" : "Allow Accessibility…",
            target: self,
            action: granted || accessibilityRequestStarted
                ? #selector(continueToMicrophone)
                : #selector(beginAccessibilityRequest)
        )
        primary.keyEquivalent = "\r"
        primary.bezelStyle = .rounded

        let secondary: NSButton? = granted ? nil : NSButton(
            title: accessibilityRequestStarted ? "Open Settings Again" : "Not Now",
            target: self,
            action: accessibilityRequestStarted
                ? #selector(beginAccessibilityRequest)
                : #selector(continueToMicrophone)
        )

        return makePage(
            stepLabel: "SETUP 1 OF 2",
            symbolName: "keyboard",
            title: "Native keyboard experience",
            detail: detail,
            status: granted ? ("Allowed", NSColor.systemGreen) : nil,
            primary: primary,
            secondary: secondary,
            footnote: "Optional, Omarchy still starts if you skip this."
        )
    }

    private func microphonePage() -> NSView {
        let state = microphoneStatus()
        let detail: String
        let primaryTitle: String
        let primaryAction: Selector
        let secondary: NSButton?
        let status: (String, NSColor)?

        switch state {
        case .authorized:
            detail = "Microphone access is allowed. Omarchy can now capture audio from your input devices."
            status = ("Allowed", .systemGreen)
        case .notDetermined:
            detail = "Allow microphone access if you want Omarchy to be able to capture your Microphone. Speaker playback does not need it."
            status = nil
        case .denied:
            detail = "Microphone access is off. Omarchy will still have sound, but apps inside it cannot record until you enable access in System Settings."
            status = ("Not allowed", .secondaryLabelColor)
        case .restricted:
            detail = "Microphone access is restricted by this Mac’s policy. Omarchy will still have speaker playback, but recording is unavailable."
            status = ("Restricted", .secondaryLabelColor)
        }

        if launchInProgress {
            primaryTitle = "Launching Omarchy…"
            primaryAction = #selector(ignoreAction)
            secondary = nil
        } else {
            switch state {
            case .authorized, .restricted:
                primaryTitle = "Launch Omarchy"
                primaryAction = #selector(finishSetup)
                secondary = nil
            case .notDetermined:
                primaryTitle = microphoneRequestInFlight ? "Waiting for macOS…" : "Allow Microphone…"
                primaryAction = #selector(beginMicrophoneRequest)
                let skip = NSButton(title: "Not Now", target: self, action: #selector(finishSetup))
                skip.isEnabled = !microphoneRequestInFlight
                secondary = skip
            case .denied:
                primaryTitle = "Launch Omarchy"
                primaryAction = #selector(finishSetup)
                secondary = NSButton(
                    title: "Open Microphone Settings",
                    target: self,
                    action: #selector(openMicrophoneSettings)
                )
            }
        }

        let primary = NSButton(title: primaryTitle, target: self, action: primaryAction)
        primary.keyEquivalent = state == .notDetermined || launchInProgress ? "" : "\r"
        primary.bezelStyle = .rounded
        primary.isEnabled = !microphoneRequestInFlight
        if launchInProgress {
            addProgressIndicator(to: primary)
        }

        return makePage(
            stepLabel: "SETUP 2 OF 2",
            symbolName: "mic",
            title: "Use your microphone in Omarchy",
            detail: detail,
            status: status,
            primary: primary,
            secondary: secondary,
            footnote: "Optional, you can enable it later in System Settings."
        )
    }

    private func addProgressIndicator(to button: NSButton) {
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)
        button.addSubview(spinner)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 178),
            spinner.centerYAnchor.constraint(equalTo: button.centerYAnchor),
            spinner.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -10),
        ])
    }

    private func makePage(
        stepLabel: String,
        symbolName: String,
        title: String,
        detail: String,
        status: (String, NSColor)?,
        primary: NSButton,
        secondary: NSButton?,
        footnote: String
    ) -> NSView {
        let step = NSTextField(labelWithString: stepLabel)
        step.font = .systemFont(ofSize: 11, weight: .semibold)
        step.textColor = .tertiaryLabelColor

        let imageView = NSImageView()
        imageView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        imageView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 30, weight: .medium)
        imageView.contentTintColor = .controlAccentColor

        let heading = NSTextField(wrappingLabelWithString: title)
        heading.font = .systemFont(ofSize: 24, weight: .semibold)
        heading.maximumNumberOfLines = 2

        let explanation = NSTextField(wrappingLabelWithString: detail)
        explanation.font = .systemFont(ofSize: 14)
        explanation.textColor = .secondaryLabelColor
        explanation.maximumNumberOfLines = 4

        var arranged: [NSView] = [step, imageView, heading, explanation]
        if let status {
            let statusLabel = NSTextField(labelWithString: "●  \(status.0)")
            statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
            statusLabel.textColor = status.1
            arranged.append(statusLabel)
        }

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        arranged.append(spacer)

        let footnoteLabel = NSTextField(labelWithString: footnote)
        footnoteLabel.font = .systemFont(ofSize: 11)
        footnoteLabel.textColor = .tertiaryLabelColor
        arranged.append(footnoteLabel)

        var buttons: [NSView] = []
        if let secondary { buttons.append(secondary) }
        buttons.append(primary)
        let buttonRow = NSStackView(views: buttons)
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .centerY
        buttonRow.distribution = .fill
        buttonRow.spacing = 10
        arranged.append(buttonRow)

        let stack = NSStackView(views: arranged)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.setCustomSpacing(18, after: imageView)
        stack.setCustomSpacing(6, after: heading)
        stack.setCustomSpacing(8, after: footnoteLabel)
        return stack
    }

    @objc private func beginAccessibilityRequest() {
        accessibilityRequestStarted = true
        requestAccessibility()
        render()
    }

    @objc private func continueToMicrophone() {
        step = .microphone
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

    @objc private func finishSetup() {
        guard !launchInProgress else { return }
        launchInProgress = true
        render()
        finish()
    }

    @objc private func ignoreAction() {}
}
