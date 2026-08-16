import Foundation
import Testing
@testable import OmarchyVMHelper

private struct Fixture {
    let root: URL
    let spec: [String: Any]

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omarchy-helper-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        spec = [
            "schemaVersion": 1,
            "image": ["architecture": "aarch64"],
            "guest": [
                "virtualDisplay": ["width": 1600, "height": 900, "refreshHz": 60, "scale": 1],
            ],
            "upstream": [
                "repository": "https://github.com/basecamp/omarchy",
                "commit": String(repeating: "a", count: 40),
                "tree": String(repeating: "b", count: 40),
                "treeSha256": String(repeating: "c", count: 64),
                "version": "4.0.0.alpha",
                "channel": "quattro",
            ],
            "runtime": [
                "kernel": "vmlinuz-linux",
                "initramfs": "initramfs-linux.img",
                "disk": "rootfs.ext4",
                "kernelCommandLine": "root=/dev/vda rw console=hvc0",
                "minimumMemoryMiB": 2048,
                "recommendedMemoryMiB": 4096,
                "minimumCpuCount": 4,
                "hypervisor": "apple-virtualization-framework",
                "devices": Array(GuestBundle.requiredDevices).sorted(),
            ],
        ]
    }

    func write(spec mutate: ((inout [String: Any]) -> Void)? = nil,
               manifest mutateManifest: ((inout [String: Any]) -> Void)? = nil) throws {
        var buildSpec = spec
        mutate?(&buildSpec)
        let specData = try JSONSerialization.data(withJSONObject: buildSpec, options: [.sortedKeys])
        try specData.write(to: root.appendingPathComponent("build-spec.json"))

        let payloads: [(String, String, Data)] = [
            ("build-spec.json", "guest-metadata", specData),
            ("vmlinuz-linux", "guest-kernel", Data("kernel".utf8)),
            ("initramfs-linux.img", "guest-initramfs", Data("initramfs".utf8)),
            ("rootfs.ext4", "guest-rootfs", Data("rootfs".utf8)),
        ]
        for (path, _, data) in payloads where path != "build-spec.json" {
            try data.write(to: root.appendingPathComponent(path))
        }
        let artifacts: [[String: Any]] = payloads.map { path, role, data in
            [
                "path": path,
                "role": role,
                "bytes": data.count,
                "sha256": Hashing.sha256(data: data),
                "mediaType": "application/octet-stream",
            ]
        }
        var manifest: [String: Any] = [
            "schemaVersion": 1,
            "guest": ["architecture": "aarch64", "distribution": "Arch Linux"],
            "artifacts": artifacts,
        ]
        mutateManifest?(&manifest)
        let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try manifestData.write(to: root.appendingPathComponent("guest-manifest.json"))
    }

    func decodeSpec() throws -> GuestBuildSpec {
        try JSONDecoder().decode(
            GuestBuildSpec.self,
            from: Data(contentsOf: root.appendingPathComponent("build-spec.json"))
        )
    }
}

@Suite("ARM guest bundle")
struct GuestBundleTests {
    @Test("accepts a complete pinned Quattro bundle")
    func acceptsValidBundle() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()

        let bundle = try GuestBundle.load(directory: fixture.root)
        #expect(bundle.spec.image.architecture == "aarch64")
        #expect(bundle.spec.upstream.channel == "quattro")
        #expect(bundle.identity.count == 64)
    }

    @Test("rejects architecture, hypervisor, device, and channel downgrades", arguments: [
        "architecture", "hypervisor", "devices", "channel",
    ])
    func rejectsContractDowngrade(kind: String) throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write(spec: { spec in
            switch kind {
            case "architecture":
                spec["image"] = ["architecture": "x86_64"]
            case "hypervisor":
                var runtime = spec["runtime"] as! [String: Any]
                runtime["hypervisor"] = "qemu-tcg"
                spec["runtime"] = runtime
            case "devices":
                var runtime = spec["runtime"] as! [String: Any]
                runtime["devices"] = ["virtio-blk"]
                spec["runtime"] = runtime
            case "channel":
                var upstream = spec["upstream"] as! [String: Any]
                upstream["channel"] = "basecamp"
                spec["upstream"] = upstream
            default:
                Issue.record("unexpected test argument")
            }
        })
        #expect(throws: HelperError.self) {
            try GuestBundle.load(directory: fixture.root)
        }
    }

    @Test("rejects artifact mutation and duplicate paths")
    func rejectsArtifactAttacks() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        try Data("mutated".utf8).write(to: fixture.root.appendingPathComponent("vmlinuz-linux"))
        #expect(throws: HelperError.self) {
            try GuestBundle.load(directory: fixture.root)
        }

        try fixture.write(manifest: { manifest in
            var artifacts = manifest["artifacts"] as! [[String: Any]]
            artifacts.append(artifacts[0])
            manifest["artifacts"] = artifacts
        })
        #expect(throws: HelperError.self) {
            try GuestBundle.load(directory: fixture.root)
        }
    }
}

@Suite("Authenticated guest report")
struct GuestReportTests {
    @Test("accepts only the exact Quattro ARM desktop identity")
    func authenticatesExactReport() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        let spec = try fixture.decodeSpec()
        let report: [String: Any] = [
            "schemaVersion": 1,
            "provenance": [
                "repository": spec.upstream.repository,
                "commit": spec.upstream.commit,
                "version": spec.upstream.version,
                "treeSha256": spec.upstream.treeSha256,
            ],
            "system": [
                "architecture": "aarch64",
                "distribution": "Arch Linux",
                "sessionType": "wayland",
            ],
            "components": [
                ["role": "compositor", "name": "Hyprland"],
                ["role": "shell", "name": "Quickshell"],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        let line = GuestReport.prefix + String(decoding: data, as: UTF8.self)
        #expect(GuestReport.authentic(line: line, spec: spec))

        var wrong = report
        var system = wrong["system"] as! [String: Any]
        system["architecture"] = "x86_64"
        wrong["system"] = system
        let wrongData = try JSONSerialization.data(withJSONObject: wrong, options: [.sortedKeys])
        #expect(!GuestReport.authentic(
            line: GuestReport.prefix + String(decoding: wrongData, as: UTF8.self),
            spec: spec
        ))

        var replay = report
        replay["components"] = [
            ["role": "compositor", "name": "Hyprland"],
            ["role": "shell", "name": "Quickshell"],
            ["role": "shell", "name": "spoof"],
        ]
        let replayData = try JSONSerialization.data(withJSONObject: replay, options: [.sortedKeys])
        #expect(!GuestReport.authentic(
            line: GuestReport.prefix + String(decoding: replayData, as: UTF8.self),
            spec: spec
        ))
    }
}

@Suite("Host-bound resume state")
struct ResumeStoreTests {
    @Test("requires exact metadata, disk, and machine state")
    func requiresCompletePair() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omarchy-resume-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ResumeStore(root: root)
        let expected = ResumeMetadata(
            schemaVersion: 1,
            bundleIdentity: String(repeating: "d", count: 64),
            architecture: "aarch64",
            cpuCount: 4,
            memoryBytes: 4 * 1024 * 1024 * 1024,
            displayWidth: 1600,
            displayHeight: 900
        )
        let directory = store.directory(for: expected.bundleIdentity)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(expected).write(to: directory.appendingPathComponent("metadata.json"))
        #expect(!store.hasCompleteState(expected))
        try Data("state".utf8).write(to: store.stateURL(for: expected.bundleIdentity))
        #expect(!store.hasCompleteState(expected))
        try Data("disk".utf8).write(to: store.diskURL(for: expected.bundleIdentity))
        #expect(store.hasCompleteState(expected))

        let wrong = ResumeMetadata(
            schemaVersion: 1,
            bundleIdentity: expected.bundleIdentity,
            architecture: "aarch64",
            cpuCount: 8,
            memoryBytes: expected.memoryBytes,
            displayWidth: 1600,
            displayHeight: 900
        )
        #expect(!store.hasCompleteState(wrong))
    }
}

@Test("capability report is explicit and architecture-safe")
func capabilityReport() {
    let report = HostCapabilities.report()
    #expect(report.schemaVersion == 1)
    #expect(report.kind == "omarchy-native-helper")
    #expect(report.runtime == "apple-virtualization-framework")
    #expect(report.display == "native-window")
    #expect(report.hostArchitecture == HostCapabilities.architecture)
    #expect(report.virtualizationAvailable == report.supportsHostBoundResume)
    #expect(report.guestArchitectures == (report.virtualizationAvailable ? ["aarch64"] : []))
}
