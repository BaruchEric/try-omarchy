import AppKit
import Foundation
@preconcurrency import Virtualization

@MainActor
final class MachineController: NSObject, VZVirtualMachineDelegate, NSApplicationDelegate, NSWindowDelegate {
    private let bundle: GuestBundle
    private let resumeStore: ResumeStore
    private let allowResume: Bool
    private let streamWindow: Bool
    private let plan: MachinePlan
    private let machineIdentifier: VZGenericMachineIdentifier
    private let expectedResume: ResumeMetadata
    private let workingLease: WorkingDirectoryLease
    private let workingDirectory: URL
    private let workingDiskURL: URL
    private let serialPipe = Pipe()
    private let serialMonitor: GuestSerialMonitor
    private var saveScheduled = false
    private var terminationRequested = false
    private var virtualMachine: VZVirtualMachine?
    private var machineView: VZVirtualMachineView?
    private var window: NSWindow?

    init(
        bundle: GuestBundle,
        resumeStore: ResumeStore,
        allowResume: Bool,
        streamWindow: Bool = false
    ) throws {
        self.bundle = bundle
        self.resumeStore = resumeStore
        self.allowResume = allowResume
        self.streamWindow = streamWindow
        let machinePlan = try MachinePlan.make(spec: bundle.spec)
        self.plan = machinePlan
        let storedMetadata = allowResume ? resumeStore.metadata(for: bundle.identity) : nil
        let storedIdentifier = storedMetadata.flatMap { metadata -> VZGenericMachineIdentifier? in
            guard metadata.schemaVersion == 2,
                  metadata.bundleIdentity == bundle.identity,
                  metadata.architecture == "aarch64",
                  metadata.cpuCount == machinePlan.cpuCount,
                  metadata.memoryBytes == machinePlan.memoryBytes,
                  metadata.displayWidth == machinePlan.width,
                  metadata.displayHeight == machinePlan.height,
                  let data = Data(base64Encoded: metadata.machineIdentifierBase64) else {
                return nil
            }
            return VZGenericMachineIdentifier(dataRepresentation: data)
        }
        let machineIdentifier = storedIdentifier ?? VZGenericMachineIdentifier()
        self.machineIdentifier = machineIdentifier
        self.expectedResume = ResumeMetadata(
            schemaVersion: 2,
            bundleIdentity: bundle.identity,
            architecture: "aarch64",
            cpuCount: machinePlan.cpuCount,
            memoryBytes: machinePlan.memoryBytes,
            displayWidth: machinePlan.width,
            displayHeight: machinePlan.height,
            machineIdentifierBase64: machineIdentifier.dataRepresentation.base64EncodedString()
        )
        self.serialMonitor = GuestSerialMonitor(spec: bundle.spec)
        let workingLease = try WorkingDirectoryLease()
        self.workingLease = workingLease
        self.workingDirectory = workingLease.directory
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
            machineIdentifier: machineIdentifier,
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
                                self.scheduleDisplayDiagnostics(stage: "snapshot-resume")
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
                        self?.scheduleDisplayDiagnostics(stage: "cold-start")
                    case .failure(let error):
                        self?.fail("VM start failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    private func showWindow(machine: VZVirtualMachine) {
        let displayPolicy = NativeDisplayPolicy.make(
            framebufferWidth: plan.width,
            framebufferHeight: plan.height,
            streamWindow: streamWindow,
            visibleFrame: NSScreen.main?.visibleFrame
        )
        let frame = NSRect(origin: .zero, size: displayPolicy.initialContentSize)
        let view = VZVirtualMachineView(frame: frame)
        view.virtualMachine = machine
        view.capturesSystemKeys = true
        view.autoresizingMask = [.width, .height]
        view.automaticallyReconfiguresDisplay = displayPolicy.automaticallyReconfiguresDisplay

        let window = NSWindow(
            contentRect: frame,
            styleMask: streamWindow ? [.borderless] : [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Omarchy Quattro · ARM64"
        window.backgroundColor = .black
        window.contentView = view
        if !streamWindow {
            window.contentMinSize = displayPolicy.minimumContentSize
            window.collectionBehavior.insert(.fullScreenPrimary)
            window.tabbingMode = .disallowed
        }
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.machineView = view
        self.window = window
        reportDisplayGeometry(stage: "window-attached")
    }

    private func scheduleDisplayDiagnostics(stage: String) {
        for (delay, suffix) in [(0.25, "settling"), (1.5, "settled")] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.reportDisplayGeometry(stage: "\(stage)-\(suffix)")
            }
        }
    }

    private func reportDisplayGeometry(stage: String) {
        guard let view = machineView, let window else { return }
        let points = view.bounds.size
        let backing = view.convertToBacking(view.bounds).size
        let scanout = virtualMachine?.graphicsDevices.first?.displays.first?.sizeInPixels
        let scanoutDescription = scanout.map {
            "\(Int($0.width.rounded()))x\(Int($0.height.rounded()))"
        } ?? "unavailable"
        print(
            "[native] Display \(stage): points=\(Int(points.width.rounded()))x\(Int(points.height.rounded())) " +
            "backing=\(Int(backing.width.rounded()))x\(Int(backing.height.rounded())) " +
            "scale=\(String(format: "%.2f", window.backingScaleFactor)) " +
            "scanout=\(scanoutDescription) auto=\(view.automaticallyReconfiguresDisplay)"
        )
    }

    private func configureSerialReader() {
        let monitor = serialMonitor
        serialPipe.fileHandleForReading.readabilityHandler = { [weak self, monitor] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            for event in monitor.consume(data) {
                switch event {
                case .diagnostic(let line):
                    BestEffortOutput.write(Data((line + "\n").utf8), to: STDOUT_FILENO)
                case .rejectedReport(let reason):
                    fputs("[native] Rejected malformed ARM desktop report (\(reason))\n", stderr)
                case .authenticReport:
                    // NSApplication.run owns the main actor for the lifetime
                    // of the window. A run-loop block reaches the VM's main
                    // queue without depending on unstructured Task progress.
                    RunLoop.main.perform(inModes: [.common]) {
                        MainActor.assumeIsolated {
                            self?.scheduleResumeCapture()
                        }
                    }
                }
            }
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
        } catch {
            print("[native] Snapshot staging failed: \(error.localizedDescription)")
            resumeAfterSnapshot(machine)
            return
        }

        let stateURL = staging.appendingPathComponent("machine.state")
        machine.saveMachineStateTo(url: stateURL) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                do {
                    if let error { throw error }
                    // Saving can drain device state while the VM is paused. Clone
                    // the disk afterwards so the disk bytes correspond to the
                    // exact device state recorded in machine.state.
                    try ResumeStore.cloneFile(
                        from: self.workingDiskURL,
                        to: staging.appendingPathComponent("rootfs.ext4")
                    )
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
        finishTermination()
    }

    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        Task { @MainActor in
            print("[native] Guest stopped")
            self.finishTermination()
        }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        let detail = error.localizedDescription
        Task { @MainActor in
            self.fail("VM stopped with error: \(detail)")
        }
    }

    func windowWillClose(_ notification: Notification) {
        requestTermination()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        scheduleDisplayDiagnostics(stage: "window-resize")
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        scheduleDisplayDiagnostics(stage: "backing-change")
    }

    func windowDidChangeScreen(_ notification: Notification) {
        scheduleDisplayDiagnostics(stage: "screen-change")
    }

    func requestTermination() {
        guard !terminationRequested else {
            finishTermination()
            return
        }
        terminationRequested = true
        guard let machine = virtualMachine, machine.state == .running else {
            finishTermination()
            return
        }
        machine.stop { [weak self] _ in
            Task { @MainActor in self?.finishTermination() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        cleanup()
    }

    func cleanup() {
        serialPipe.fileHandleForReading.readabilityHandler = nil
        workingLease.cleanup()
    }

    private func finishTermination() {
        cleanup()
        NSApplication.shared.terminate(nil)
    }
}
