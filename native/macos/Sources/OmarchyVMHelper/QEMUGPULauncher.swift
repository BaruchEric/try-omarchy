import AVFoundation
import Darwin
import Foundation

enum QEMUGPUStorageOption: String, Equatable {
    case ephemeral = "--ephemeral"
    case resetStorage = "--reset-storage"
}

struct QEMUGPULaunchRequest: Equatable {
    let storageOption: QEMUGPUStorageOption?
    let guestDirectoryPath: String?

    init(
        storageOption: QEMUGPUStorageOption?,
        guestDirectoryPath: String?
    ) {
        self.storageOption = storageOption
        self.guestDirectoryPath = guestDirectoryPath
    }

    init?(arguments: [String]) {
        var remaining = arguments[...]
        var storageOption: QEMUGPUStorageOption?

        if let first = remaining.first,
           let parsedOption = QEMUGPUStorageOption(rawValue: first) {
            storageOption = parsedOption
            remaining = remaining.dropFirst()
        }

        guard remaining.count <= 1 else { return nil }
        let guestDirectoryPath = remaining.first
        if let guestDirectoryPath {
            guard guestDirectoryPath.hasPrefix("/"),
                  !guestDirectoryPath.hasPrefix("--"),
                  !guestDirectoryPath.contains("\n"),
                  !guestDirectoryPath.contains("\r") else { return nil }
        }

        self.storageOption = storageOption
        self.guestDirectoryPath = guestDirectoryPath
    }

    func validatedScriptArguments() throws -> [String] {
        var result = storageOption.map { [$0.rawValue] } ?? []
        guard let guestDirectoryPath else { return result }

        let guestDirectory = URL(
            fileURLWithPath: guestDirectoryPath,
            isDirectory: true
        ).standardizedFileURL
        var information = stat()
        guard Darwin.lstat(guestDirectory.path, &information) == 0,
              information.st_mode & S_IFMT == S_IFDIR else {
            throw HelperError.io("ARM guest directory is missing or unsafe: \(guestDirectory.path)")
        }

        let canonicalDirectory = guestDirectory.resolvingSymlinksInPath()
        result.append(canonicalDirectory.path)
        return result
    }

}

enum QEMUGPULauncherPath {
    static let appName = "Omarchy Quattro.app"
    static let launcherName = "run-qemu-gpu.sh"

    static func resolve(bundleURL: URL) throws -> URL {
        let standardizedBundle = bundleURL.standardizedFileURL
        var bundleInformation = stat()
        guard standardizedBundle.lastPathComponent == appName,
              Darwin.lstat(standardizedBundle.path, &bundleInformation) == 0,
              bundleInformation.st_mode & S_IFMT == S_IFDIR else {
            throw HelperError.io("QEMU launch is available only from the built Omarchy app")
        }

        let canonicalBundle = standardizedBundle.resolvingSymlinksInPath()
        let resources = canonicalBundle
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Resources", isDirectory: true)
        let scripts = resources.appendingPathComponent("scripts", isDirectory: true)
        let launcher = scripts.appendingPathComponent(launcherName, isDirectory: false)
        let canonicalLauncher = launcher.resolvingSymlinksInPath()
        var launcherInformation = stat()
        guard canonicalLauncher.deletingLastPathComponent() == scripts,
              Darwin.lstat(launcher.path, &launcherInformation) == 0,
              launcherInformation.st_mode & S_IFMT == S_IFREG,
              FileManager.default.isExecutableFile(atPath: launcher.path) else {
            throw HelperError.io("bundled QEMU launcher is missing or unsafe: \(launcher.path)")
        }
        return canonicalLauncher
    }
}

enum MicrophoneAuthorizationState: Equatable {
    case authorized
    case denied
    case restricted
}

struct MicrophoneLaunchDecision: Equatable {
    let allowsLaunch: Bool
    let warning: String?

    static func make(for state: MicrophoneAuthorizationState) -> Self {
        switch state {
        case .authorized:
            Self(allowsLaunch: true, warning: nil)
        case .denied:
            Self(
                allowsLaunch: true,
                warning: "Microphone access is denied. Audio playback will continue, but guest recording is unavailable. Enable Omarchy Quattro in System Settings > Privacy & Security > Microphone, then relaunch."
            )
        case .restricted:
            Self(
                allowsLaunch: true,
                warning: "Microphone access is restricted by macOS policy. Audio playback will continue, but guest recording is unavailable. Ask the Mac administrator to allow microphone access for Omarchy Quattro."
            )
        }
    }
}

enum MicrophonePreflight {
    private final class RequestResult: @unchecked Sendable {
        private let lock = NSLock()
        private var granted = false

        func set(_ granted: Bool) {
            lock.lock()
            self.granted = granted
            lock.unlock()
        }

        func get() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return granted
        }
    }

    static func decision() -> MicrophoneLaunchDecision {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .make(for: .authorized)
        case .denied:
            return .make(for: .denied)
        case .restricted:
            return .make(for: .restricted)
        case .notDetermined:
            let completion = DispatchSemaphore(value: 0)
            let result = RequestResult()
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                result.set(granted)
                completion.signal()
            }
            while completion.wait(timeout: .now() + 0.05) == .timedOut {
                _ = RunLoop.current.run(
                    mode: .default,
                    before: Date(timeIntervalSinceNow: 0.05)
                )
            }
            return .make(for: result.get() ? .authorized : .denied)
        @unknown default:
            return .make(for: .restricted)
        }
    }
}

final class QEMUGPUProcessSupervisor: @unchecked Sendable {
    private let lock = NSLock()
    private var child: Process?

    func start(
        executableURL: URL,
        arguments: [String],
        environment: [String: String],
        completion: @escaping @MainActor @Sendable (Int32) -> Void
    ) throws {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.standardInput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] process in
            self?.clear(process)
            let status = Self.status(for: process)
            // NSApplication owns a synchronous AppKit run loop. Dispatching a
            // main-queue block lets that run loop service child completion;
            // a MainActor Task could wait behind the still-running call.
            DispatchQueue.main.async {
                completion(status)
            }
        }

        lock.lock()
        guard child == nil else {
            lock.unlock()
            throw HelperError.io("QEMU launcher process is already running")
        }
        child = process
        lock.unlock()

        do {
            try process.run()
        } catch {
            clear(process)
            throw error
        }
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return child?.isRunning == true
    }

    func forward(signal: Int32) {
        lock.lock()
        defer { lock.unlock() }
        guard let child, child.isRunning else { return }
        _ = Darwin.kill(child.processIdentifier, signal)
    }

    private func clear(_ process: Process) {
        lock.lock()
        if child === process { child = nil }
        lock.unlock()
    }

    private static func status(for process: Process) -> Int32 {
        switch process.terminationReason {
        case .exit:
            return process.terminationStatus
        case .uncaughtSignal:
            return 128 + process.terminationStatus
        @unknown default:
            return 1
        }
    }
}
