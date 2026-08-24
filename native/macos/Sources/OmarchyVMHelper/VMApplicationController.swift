import AppKit
import ApplicationServices
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
    private let setupCompletionStore: PermissionSetupCompletionStore
    private let launchStatusWindow = LaunchStatusWindow()
    private var permissionSetupWindow: PermissionSetupWindow?

    private var lifecycle = VMRunLifecycle()
    private var childRunning = false
    private var applicationTerminationPending = false
    private var virtualMachineReachedStart = false

    private(set) var exitStatus: Int32 = 0

    init(
        launcherURL: URL,
        initialArguments: [String],
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        supervisor: QEMUGPUProcessSupervisor = QEMUGPUProcessSupervisor(),
        preferenceStore: AudioRoutingPreferenceStore = AudioRoutingPreferenceStore(),
        deviceProvider: HostAudioDeviceProviding = CoreAudioHostAudioDeviceProvider(),
        setupCompletionStore: PermissionSetupCompletionStore = PermissionSetupCompletionStore()
    ) {
        self.launcherURL = launcherURL
        self.initialArguments = initialArguments
        self.baseEnvironment = baseEnvironment
        self.supervisor = supervisor
        self.preferenceStore = preferenceStore
        self.deviceProvider = deviceProvider
        self.setupCompletionStore = setupCompletionStore
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if setupCompletionStore.isComplete {
            startVirtualMachine(showLaunchStatus: true)
        } else {
            showPermissionSetup()
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        permissionSetupWindow?.refreshPermissionStatus()
    }

    private func showPermissionSetup() {
        let setupWindow = PermissionSetupWindow(
            accessibilityStatus: { AXIsProcessTrusted() },
            microphoneStatus: { MicrophonePreflight.authorizationState() },
            requestAccessibility: { [weak self] in
                self?.requestOptionalAccessibilityPermission()
            },
            requestMicrophone: { completion in
                MicrophonePreflight.requestAccess(completion: completion)
            },
            finish: { [weak self] in
                self?.completePermissionSetup()
            }
        )
        permissionSetupWindow = setupWindow
        setupWindow.show()
    }

    private func completePermissionSetup() {
        setupCompletionStore.markComplete()
        startVirtualMachine(showLaunchStatus: false)
    }

    private func startVirtualMachine(showLaunchStatus: Bool) {
        virtualMachineReachedStart = false
        if showLaunchStatus {
            launchStatusWindow.show()
        }
        do {
            let accessibilityDecision = AccessibilityLaunchDecision.make(
                for: AXIsProcessTrusted() ? .authorized : .unavailable
            )
            if let warning = accessibilityDecision.warning {
                fputs("[input-bridge] \(warning)\n", stderr)
            }
            guard accessibilityDecision.allowsLaunch else {
                throw HelperError.io("accessibility policy unexpectedly prevented launch")
            }
            let microphoneDecision = MicrophonePreflight.decision()
            if let warning = microphoneDecision.warning {
                fputs("[audio] \(warning)\n", stderr)
            }
            guard microphoneDecision.allowsLaunch else {
                throw HelperError.io("microphone policy unexpectedly prevented audio playback")
            }
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
                if event == .virtualMachineReady {
                    self?.virtualMachineDidStart()
                }
            }
        ) { [weak self] status in
            self?.childDidExit(status: status)
        }
        childRunning = true
    }

    private func virtualMachineDidStart() {
        virtualMachineReachedStart = true
        permissionSetupWindow?.dismiss()
        permissionSetupWindow = nil
        launchStatusWindow.dismiss()
    }

    private func requestOptionalAccessibilityPermission() {
        guard !AXIsProcessTrusted() else { return }
        let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
    }

    private func childDidExit(status: Int32) {
        guard childRunning else { return }
        childRunning = false

        let wasStopping = lifecycle.isStopping
        let presentation = VMExitPresentationDecision.make(
            status: status,
            reachedVirtualMachineStart: virtualMachineReachedStart,
            wasStopping: wasStopping
        )
        lifecycle.childExited()
        launchStatusWindow.dismiss()
        if applicationTerminationPending {
            NSApp.reply(toApplicationShouldTerminate: true)
        } else {
            if presentation.showsStartupFailure {
                let alert = NSAlert()
                alert.alertStyle = .critical
                alert.messageText = "Try Omarchy couldn’t start"
                alert.informativeText = "The app’s virtual machine stopped during startup. Reinstall the latest Omarchy app and try again."
                alert.addButton(withTitle: "Close")
                alert.runModal()
            }
            finish(status: status)
        }
    }

    private func failLaunch(_ error: Error) {
        fputs("omarchy-vm-helper: \(error.localizedDescription)\n", stderr)
        permissionSetupWindow?.dismiss()
        permissionSetupWindow = nil
        launchStatusWindow.dismiss()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Try Omarchy couldn’t start"
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
