import AppKit

@MainActor
final class LaunchStatusWindow {
    private let window: NSWindow
    private let spinner = NSProgressIndicator()

    init() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 168),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Try Omarchy"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.level = .floating

        let title = NSTextField(labelWithString: "Starting Try Omarchy")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.alignment = .center

        let detail = NSTextField(
            wrappingLabelWithString: "Preparing your virtual Mac. The first launch takes a little longer."
        )
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.maximumNumberOfLines = 2

        spinner.style = .spinning
        spinner.controlSize = .regular

        let stack = NSStackView(views: [spinner, title, detail])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: 7),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -28),
            detail.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
        ])
    }

    func show() {
        spinner.startAnimation(nil)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func dismiss() {
        spinner.stopAnimation(nil)
        window.orderOut(nil)
    }
}
