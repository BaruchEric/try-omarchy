import AppKit
import Foundation
@preconcurrency import Virtualization

@MainActor
final class MachineController: NSObject, VZVirtualMachineDelegate, NSWindowDelegate {
    private let bundle: GuestBundle
    private let resumeStore: ResumeStore
    private let allowResume: Bool
    private let plan: MachinePlan
    private let expectedResume: ResumeMetadata
    private let workingDirectory: URL
    private let workingDiskURL: URL
    private let serialPipe = Pipe()
    private var serialBuffer = ""
    private var saveScheduled = false
    private var virtualMachine: VZVirtualMachine?
    private var window: NSWindow?

    init(bundle: GuestBundle, resumeStore: ResumeStore, allowResume: Bool) throws {
        self.bundle = bundle
        self.resumeStore = resumeStore
        self.allowResume = allowResume
        self.plan = try MachinePlan.make(spec: bundle.spec)
        self.expectedResume = ResumeMetadata(
            schemaVersion: 1,
            bundleIdentity: bundle.identity,
            architecture: "aarch64",
            cpuCount: plan.cpuCount,
            memoryBytes: plan.memoryBytes,
            displayWidth: plan.width,
            displayHeight: plan.height
        )
        self.workingDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("omarchy-native-\(UUID().uuidString)", isDirectory: true)
        self.workingDiskURL = workingDirectory.appendingPathComponent("rootfs.ext4")
        super.init()
    }

    func start() throws {
        try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
        let restoring = allowResume && resumeStore.hasCompleteState(expectedResume)
        let sourceDisk = restoring
            ? resumeStore.diskURL(for: bundle.identity)
            : bundle.rootfsURL
        try ResumeStore.cloneFile(from: sourceDisk, to: workingDiskURL)

        let configuration = try MachineConfiguration.make(
            bundle: bundle,
            diskURL: workingDiskURL,
            plan: plan,
            serialOutput: serialPipe.fileHandleForWriting
        )
        let machine = VZVirtualMachine(configuration: configuration)
        machine.delegate = self
        virtualMachine = machine
        configureSerialReader()
        showWindow(machine: machine)

        if restoring {
            print("[native] Restoring host-bound ARM snapshot \(bundle.identity.prefix(12))")
            machine.restoreMachineStateFrom(url: resumeStore.stateURL(for: bundle.identity)) { [weak self] error in
                Task { @MainActor in
                    guard let self else { return }
                    if let error {
                        self.fail("snapshot restore failed closed: \(error.localizedDescription)")
                        return
                    }
                    machine.resume { result in
                        Task { @MainActor in
                            switch result {
                            case .success:
                                print("[native] ARM snapshot resumed")
                            case .failure(let error):
                                self.fail("snapshot resume failed: \(error.localizedDescription)")
                            }
                        }
                    }
                }
            }
        } else {
            print("[native] Cold-starting ARM Quattro; an authenticated ready state will be cached for later launches")
            machine.start { [weak self] result in
                Task { @MainActor in
                    switch result {
                    case .success:
                        print("[native] ARM virtual machine started")
                    case .failure(let error):
                        self?.fail("VM start failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    private func showWindow(machine: VZVirtualMachine) {
        let frame = NSRect(x: 0, y: 0, width: plan.width, height: plan.height)
        let view = VZVirtualMachineView(frame: frame)
        view.virtualMachine = machine
        view.capturesSystemKeys = true
        view.automaticallyReconfiguresDisplay = false

        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Omarchy Quattro · ARM64"
        window.contentView = view
        window.contentAspectRatio = NSSize(width: plan.width, height: plan.height)
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = window
    }

    private func configureSerialReader() {
        serialPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.consumeSerial(data) }
            BestEffortOutput.write(data, to: STDOUT_FILENO)
        }
    }

    private func consumeSerial(_ data: Data) {
        serialBuffer += String(decoding: data, as: UTF8.self)
        while let newline = serialBuffer.firstIndex(of: "\n") {
            let line = String(serialBuffer[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
            serialBuffer.removeSubrange(...newline)
            if GuestReport.authentic(line: line, spec: bundle.spec) {
                scheduleResumeCapture()
            }
        }
        if serialBuffer.utf8.count > 512 * 1024 {
            serialBuffer = String(serialBuffer.suffix(64 * 1024))
        }
    }

    private func scheduleResumeCapture() {
        guard allowResume, !saveScheduled, !resumeStore.hasCompleteState(expectedResume) else { return }
        saveScheduled = true
        print("[native] Authentic ARM desktop report received; scheduling host-bound snapshot")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.captureResumeState()
        }
    }

    private func captureResumeState() {
        guard let machine = virtualMachine, machine.state == .running else {
            saveScheduled = false
            return
        }
        machine.pause { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.saveScheduled = false
                    print("[native] Snapshot pause skipped: \(error.localizedDescription)")
                case .success:
                    self.writePausedState(machine: machine)
                }
            }
        }
    }

    private func writePausedState(machine: VZVirtualMachine) {
        let final = resumeStore.directory(for: bundle.identity)
        let staging = resumeStore.root.appendingPathComponent(".\(bundle.identity).\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            try ResumeStore.cloneFile(from: workingDiskURL, to: staging.appendingPathComponent("rootfs.ext4"))
        } catch {
            print("[native] Snapshot disk clone failed: \(error.localizedDescription)")
            resumeAfterSnapshot(machine)
            return
        }

        let stateURL = staging.appendingPathComponent("machine.state")
        machine.saveMachineStateTo(url: stateURL) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                do {
                    if let error { throw error }
                    let metadata = try JSONEncoder().encode(self.expectedResume)
                    try metadata.write(to: staging.appendingPathComponent("metadata.json"), options: .atomic)
                    if FileManager.default.fileExists(atPath: final.path) {
                        try FileManager.default.removeItem(at: final)
                    }
                    try FileManager.default.moveItem(at: staging, to: final)
                    print("[native] Host-bound ARM snapshot cached")
                } catch {
                    try? FileManager.default.removeItem(at: staging)
                    print("[native] Snapshot save failed: \(error.localizedDescription)")
                }
                self.resumeAfterSnapshot(machine)
            }
        }
    }

    private func resumeAfterSnapshot(_ machine: VZVirtualMachine) {
        machine.resume { [weak self] result in
            Task { @MainActor in
                self?.saveScheduled = false
                if case .failure(let error) = result {
                    self?.fail("VM resume after snapshot failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func fail(_ message: String) {
        fputs("omarchy-vm-helper: \(message)\n", stderr)
        NSApplication.shared.terminate(nil)
    }

    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        Task { @MainActor in
            print("[native] Guest stopped")
            NSApplication.shared.terminate(nil)
        }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        let detail = error.localizedDescription
        Task { @MainActor in
            self.fail("VM stopped with error: \(detail)")
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let machine = virtualMachine, machine.state == .running else {
            NSApplication.shared.terminate(nil)
            return
        }
        machine.stop { _ in
            Task { @MainActor in NSApplication.shared.terminate(nil) }
        }
    }

    func cleanup() {
        serialPipe.fileHandleForReading.readabilityHandler = nil
        try? FileManager.default.removeItem(at: workingDirectory)
    }
}
