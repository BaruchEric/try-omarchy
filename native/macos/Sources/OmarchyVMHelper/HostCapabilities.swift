import Foundation
#if canImport(Virtualization)
@preconcurrency import Virtualization
#endif

enum HostCapabilities {
    static var architecture: String {
        #if arch(arm64)
        "arm64"
        #elseif arch(x86_64)
        "x86_64"
        #else
        "unknown"
        #endif
    }

    static var virtualizationAvailable: Bool {
        #if canImport(Virtualization) && arch(arm64)
        VZVirtualMachine.isSupported
        #else
        false
        #endif
    }

    static func report() -> HelperCapabilities {
        HelperCapabilities(
            schemaVersion: 1,
            kind: "omarchy-native-helper",
            helperVersion: "0.1.0",
            hostArchitecture: architecture,
            virtualizationAvailable: virtualizationAvailable,
            guestArchitectures: virtualizationAvailable ? ["aarch64"] : [],
            runtime: "apple-virtualization-framework",
            display: "native-window",
            supportsHostBoundResume: virtualizationAvailable
        )
    }
}
