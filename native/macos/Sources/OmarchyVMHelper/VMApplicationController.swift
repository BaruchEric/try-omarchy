import AppKit
import Darwin
import Foundation

@MainActor
final class VMApplicationController: NSObject, NSApplicationDelegate {
    private let launcherURL: URL
    private let initialArguments: [String]
    private let baseEnvironment: [String: String]
    private let supervisor: QEMUGPUProcessSupervisor
    private let preferenceStore: AudioRoutingPreferenceStore
    private let deviceProvider: HostAudioDeviceProviding
    private let launchStatusWindow = LaunchStatusWindow()

    private var lifecycle = VMRunLifecycle()
    private var childRunning = false
    private var applicationTerminationPending = false

    private(set) var exitStatus: Int32 = 0

    init(
        launcherURL: URL,
        initialArguments: [String],
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        supervisor: QEMUGPUProcessSupervisor = QEMUGPUProcessSupervisor(),
        preferenceStore: AudioRoutingPreferenceStore = AudioRoutingPreferenceStore(),
        deviceProvider: HostAudioDeviceProviding = CoreAudioHostAudioDeviceProvider()
    ) {
        self.launcherURL = launcherURL
        self.initialArguments = initialArguments
        self.baseEnvironment = baseEnvironment
        self.supervisor = supervisor
        self.preferenceStore = preferenceStore
        self.deviceProvider = deviceProvider
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        launchStatusWindow.show()
        do {
            try launch(arguments: initialArguments)
        } catch {
            failLaunch(error)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard childRunning else { return .terminateNow }
        guard !applicationTerminationPending else { return .terminateLater }

        applicationTerminationPending = true
        lifecycle.requestQuit()
        supervisor.forward(signal: SIGTERM)
        return .terminateLater
    }

    func handleTerminationSignal(_ signal: Int32) {
        guard !applicationTerminationPending else { return }
        lifecycle.requestTermination(signal: signal)
        if childRunning {
            supervisor.forward(signal: signal)
        } else {
            finish(status: 128 + signal)
        }
    }

    private func launch(arguments: [String]) throws {
        let preferences = preferenceStore.load()
        let catalog = deviceProvider.catalog()
        let configuration = AudioLaunchConfiguration.make(
            baseEnvironment: baseEnvironment,
            preferences: preferences,
            catalog: catalog
        )

        try supervisor.start(
            executableURL: launcherURL,
            arguments: arguments,
            environment: configuration.environment,
            launchEvent: { [weak self] event in
                if event == .virtualMachineStarting {
                    self?.launchStatusWindow.dismiss()
                }
            }
        ) { [weak self] status in
            self?.childDidExit(status: status)
        }
        childRunning = true
    }

    private func childDidExit(status: Int32) {
        guard childRunning else { return }
        childRunning = false

        lifecycle.childExited()
        launchStatusWindow.dismiss()
        if applicationTerminationPending {
            NSApp.reply(toApplicationShouldTerminate: true)
        } else {
            if status != 0 {
                let alert = NSAlert()
                alert.alertStyle = .critical
                alert.messageText = "Omarchy couldn’t start"
                alert.informativeText = "The app’s virtual machine stopped during startup. Reinstall the latest Omarchy app and try again."
                alert.addButton(withTitle: "Close")
                alert.runModal()
            }
            finish(status: status)
        }
    }

    private func failLaunch(_ error: Error) {
        fputs("omarchy-vm-helper: \(error.localizedDescription)\n", stderr)
        launchStatusWindow.dismiss()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Omarchy couldn’t start"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Close")
        alert.runModal()
        finish(status: 1)
    }

    private func finish(status: Int32) {
        exitStatus = status
        NSApp.stop(nil)

        // `stop` takes effect after the current event is handled. Posting a
        // private wake-up also covers completion handlers that arrive while
        // the application is otherwise idle.
        if let wakeUp = NSEvent.otherEvent(
            with: .applicationDefined,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            subtype: 0,
            data1: 0,
            data2: 0
        ) {
            NSApp.postEvent(wakeUp, atStart: false)
        }
    }
}
