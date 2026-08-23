import AppKit
import ApplicationServices
import Darwin
import Foundation

private var terminationSignalSources: [DispatchSourceSignal] = []

private func usage() -> Never {
    fputs("Usage: omarchy-vm-helper --run-qemu [--ephemeral | --reset-storage] [GUEST_DIR] | --bridge-command-super QEMU_PID QMP_SOCKET\n", stderr)
    exit(64)
}

private func effectiveArguments() -> [String] {
    let supplied = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
    if !supplied.isEmpty {
        return Array(supplied)
    }
    return Bundle.main.bundleURL.pathExtension == "app" ? ["--run-qemu"] : []
}

@discardableResult
private func requestAccessibilityPermission() -> Bool {
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
}

@MainActor
private func waitForAccessibilityPermission() -> Bool {
    guard !AXIsProcessTrusted() else { return true }

    requestAccessibilityPermission()
    let deadline = Date(timeIntervalSinceNow: 300)
    while Date() < deadline {
        if AXIsProcessTrusted() {
            return true
        }
        _ = RunLoop.current.run(
            mode: .default,
            before: Date(timeIntervalSinceNow: 0.25)
        )
    }
    return AXIsProcessTrusted()
}

let arguments = effectiveArguments()
do {
    if arguments.first == "--bridge-command-super" {
        guard arguments.count == 3,
              let processIdentifier = Int32(arguments[1]),
              processIdentifier > 1 else { usage() }
        if !AXIsProcessTrusted() {
            requestAccessibilityPermission()
        }
        guard AXIsProcessTrusted() else {
            throw HelperError.io(
                "Accessibility permission is required for focused Command-key capture; grant it in System Settings, then retry"
            )
        }
        let bridge = try FocusedCommandSuperBridge(
            targetPID: processIdentifier,
            qmpSocketPath: arguments[2]
        )
        for signalNumber in [SIGINT, SIGTERM] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { bridge.stop() }
            source.resume()
            terminationSignalSources.append(source)
        }
        fputs("[input-bridge] Command is captured as guest Super only while QEMU pid \(processIdentifier) is focused.\n", stderr)
        try bridge.run()
        exit(0)
    }

    if arguments.first == "--run-qemu" {
        guard let request = QEMUGPULaunchRequest(arguments: Array(arguments.dropFirst())) else {
            usage()
        }
        let launcher = try QEMUGPULauncherPath.resolve(bundleURL: Bundle.main.bundleURL)
        let launcherArguments = try request.validatedScriptArguments()
        let restartArguments = try request.validatedRestartScriptArguments()
        guard MainActor.assumeIsolated({ waitForAccessibilityPermission() }) else {
            throw HelperError.io(
                "timed out waiting for Accessibility permission; enable Omarchy Quattro in System Settings, then retry"
            )
        }
        let microphoneDecision = MicrophonePreflight.decision()
        if let warning = microphoneDecision.warning {
            fputs("[audio] \(warning)\n", stderr)
        }
        guard microphoneDecision.allowsLaunch else {
            throw HelperError.io("microphone policy unexpectedly prevented audio playback")
        }

        // The executable's top level starts on the process main thread. Make
        // that invariant explicit so the AppKit lifecycle stays MainActor
        // isolated while `NSApplication.run()` services its event loop.
        let status = MainActor.assumeIsolated { () -> Int32 in
            let application = NSApplication.shared
            application.setActivationPolicy(.accessory)
            let controller = VMApplicationController(
                launcherURL: launcher,
                initialArguments: launcherArguments,
                restartArguments: restartArguments,
                restartAllowed: request.allowsAudioRestart
            )
            application.delegate = controller
            for signalNumber in [SIGHUP, SIGINT, SIGTERM] {
                Darwin.signal(signalNumber, SIG_IGN)
                let source = DispatchSource.makeSignalSource(
                    signal: signalNumber,
                    queue: .main
                )
                source.setEventHandler {
                    MainActor.assumeIsolated {
                        controller.handleTerminationSignal(signalNumber)
                    }
                }
                source.resume()
                terminationSignalSources.append(source)
            }
            application.run()
            return controller.exitStatus
        }
        exit(status)
    }

    usage()
} catch {
    fputs("omarchy-vm-helper: \(error.localizedDescription)\n", stderr)
    exit(1)
}
