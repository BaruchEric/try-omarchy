import AppKit
import Foundation

private func usage() -> Never {
    fputs("Usage: omarchy-vm-helper --capabilities | --validate GUEST_DIR | --run GUEST_DIR [--no-resume] | --serve GUEST_DIR --allowed-origin ORIGIN [--port PORT]\n", stderr)
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
    case "--serve":
        guard let originIndex = arguments.firstIndex(of: "--allowed-origin"),
              originIndex + 1 < arguments.count,
              let originURL = URL(string: arguments[originIndex + 1]),
              ["http", "https"].contains(originURL.scheme),
              originURL.host != nil,
              originURL.path.isEmpty || originURL.path == "/",
              originURL.query == nil,
              originURL.fragment == nil else { usage() }
        let allowedOrigin = "\(originURL.scheme!)://\(originURL.host!)" + (originURL.port.map { ":\($0)" } ?? "")
        let port: UInt16
        if let portIndex = arguments.firstIndex(of: "--port"), portIndex + 1 < arguments.count,
           let parsed = UInt16(arguments[portIndex + 1]), parsed > 0 {
            port = parsed
        } else {
            port = LoopbackServer.defaultPort
        }
        let allowedArguments = Set([0, 1, originIndex, originIndex + 1] + (arguments.firstIndex(of: "--port").map { [$0, $0 + 1] } ?? []))
        guard allowedArguments.count == arguments.count else { usage() }
        let bundle = try GuestBundle.load(directory: directory)
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let launcher = NativeVMLauncher(executableURL: executable, bundleDirectory: directory)
        try LoopbackServer.serve(port: port, allowedOrigin: allowedOrigin, bundle: bundle, launcher: launcher)
    default:
        usage()
    }
} catch {
    fputs("omarchy-vm-helper: \(error.localizedDescription)\n", stderr)
    exit(1)
}
