import AppKit
import Foundation

private func usage() -> Never {
    fputs("Usage: omarchy-vm-helper --capabilities | --validate GUEST_DIR | --run GUEST_DIR [--no-resume]\n", stderr)
    exit(64)
}

private func printJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
do {
    if arguments == ["--capabilities"] {
        try printJSON(HostCapabilities.report())
        exit(0)
    }

    guard arguments.count >= 2 else { usage() }
    let command = arguments[0]
    let directory = URL(fileURLWithPath: arguments[1], isDirectory: true).standardizedFileURL
    let allowResume = !arguments.dropFirst(2).contains("--no-resume")

    switch command {
    case "--validate":
        guard arguments.count == 2 else { usage() }
        let bundle = try GuestBundle.load(directory: directory)
        try printJSON([
            "architecture": bundle.spec.image.architecture,
            "bundleIdentity": bundle.identity,
            "commit": bundle.spec.upstream.commit,
            "hypervisor": bundle.spec.runtime.hypervisor ?? "",
            "status": "valid",
        ])
    case "--run":
        guard arguments.count == 2 || (arguments.count == 3 && !allowResume) else { usage() }
        guard HostCapabilities.virtualizationAvailable else {
            throw HelperError.unsupportedHost("requires Apple Silicon and Virtualization.framework")
        }
        let bundle = try GuestBundle.load(directory: directory)
        try MainActor.assumeIsolated {
            let controller = try MachineController(
                bundle: bundle,
                resumeStore: ResumeStore(),
                allowResume: allowResume
            )
            let application = NSApplication.shared
            application.setActivationPolicy(.regular)
            try controller.start()
            application.run()
            controller.cleanup()
        }
    default:
        usage()
    }
} catch {
    fputs("omarchy-vm-helper: \(error.localizedDescription)\n", stderr)
    exit(1)
}
