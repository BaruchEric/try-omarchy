import Foundation

enum HelperError: LocalizedError, Equatable {
    case invalidBundle(String)
    case unsupportedHost(String)
    case io(String)

    var errorDescription: String? {
        switch self {
        case .invalidBundle(let detail): "Invalid ARM guest bundle: \(detail)"
        case .unsupportedHost(let detail): "Unsupported host: \(detail)"
        case .io(let detail): "I/O failure: \(detail)"
        }
    }
}

struct ArtifactRecord: Decodable, Equatable {
    let path: String
    let role: String
    let bytes: UInt64
    let sha256: String
    let mediaType: String
}

struct GuestArtifactManifest: Decodable {
    struct Guest: Decodable {
        let architecture: String
        let distribution: String
    }

    let schemaVersion: Int
    let guest: Guest
    let artifacts: [ArtifactRecord]
}

struct GuestBuildSpec: Decodable {
    struct Image: Decodable {
        let architecture: String
    }

    struct Display: Decodable {
        let width: Int
        let height: Int
        let refreshHz: Int
        let scale: Int
    }

    struct Guest: Decodable {
        let virtualDisplay: Display
    }

    struct Upstream: Decodable {
        let repository: String
        let commit: String
        let tree: String
        let treeSha256: String
        let version: String
        let channel: String?
    }

    struct Runtime: Decodable {
        let kernel: String
        let initramfs: String
        let disk: String
        let kernelCommandLine: String
        let minimumMemoryMiB: Int
        let recommendedMemoryMiB: Int
        let minimumCpuCount: Int?
        let hypervisor: String?
        let devices: [String]
    }

    let schemaVersion: Int
    let image: Image
    let guest: Guest
    let upstream: Upstream
    let runtime: Runtime
}

struct ResumeMetadata: Codable, Equatable {
    let schemaVersion: Int
    let bundleIdentity: String
    let architecture: String
    let cpuCount: Int
    let memoryBytes: UInt64
    let displayWidth: Int
    let displayHeight: Int
    let machineIdentifierBase64: String
}

struct HelperCapabilities: Codable, Equatable {
    let schemaVersion: Int
    let kind: String
    let helperVersion: String
    let hostArchitecture: String
    let virtualizationAvailable: Bool
    let guestArchitectures: [String]
    let runtime: String
    let display: String
    let supportsHostBoundResume: Bool
}

struct NativeGuestIdentity: Codable, Equatable {
    let architecture: String
    let channel: String
    let repository: String
    let commit: String
    let version: String
    let treeSha256: String
    let bundleIdentity: String
}

struct NativeCapabilityEnvelope: Codable, Equatable {
    let schemaVersion: Int
    let kind: String
    let helperVersion: String
    let challenge: String
    let hostArchitecture: String
    let virtualizationAvailable: Bool
    let guestArchitectures: [String]
    let runtime: String
    let display: String
    let supportsHostBoundResume: Bool
    let guest: NativeGuestIdentity
}

struct NativeLaunchEnvelope: Codable, Equatable {
    let schemaVersion: Int
    let accepted: Bool
    let challenge: String
    let bundleIdentity: String
    let architecture: String
    let display: String
}
