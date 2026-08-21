import CoreGraphics
import Foundation
import Testing
@testable import OmarchyVMHelper

@Suite("Best-effort serial output")
struct BestEffortOutputTests {
    @Test("retries interruption and stops harmlessly at backpressure")
    func handlesNonblockingOutput() {
        let data = Data("authenticated-report".utf8)
        var calls = 0
        let written = BestEffortOutput.write(data, to: 1) { _, _, count in
            calls += 1
            switch calls {
            case 1:
                errno = EINTR
                return -1
            case 2:
                return min(5, count)
            default:
                errno = EAGAIN
                return -1
            }
        }
        #expect(calls == 3)
        #expect(written == 5)
    }

    @Test("writes every byte across bounded partial writes")
    func handlesPartialWrites() {
        let data = Data("desktop-ready".utf8)
        var calls = 0
        let written = BestEffortOutput.write(data, to: 1) { _, _, count in
            calls += 1
            return min(3, count)
        }
        #expect(written == data.count)
        #expect(calls > 1)
    }
}

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
        #expect(GuestReport.rejectionReason(line: line, spec: spec) == nil)

        var wrong = report
        var system = wrong["system"] as! [String: Any]
        system["architecture"] = "x86_64"
        wrong["system"] = system
        let wrongData = try JSONSerialization.data(withJSONObject: wrong, options: [.sortedKeys])
        #expect(!GuestReport.authentic(
            line: GuestReport.prefix + String(decoding: wrongData, as: UTF8.self),
            spec: spec
        ))
        #expect(GuestReport.rejectionReason(
            line: GuestReport.prefix + String(decoding: wrongData, as: UTF8.self),
            spec: spec
        ) == "system")

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

@Suite("Ordered guest serial monitor")
struct GuestSerialMonitorTests {
    @Test("authenticates one report split across arbitrary pipe reads")
    func authenticatesSplitReport() throws {
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
                ["role": "shell", "name": "quickshell"],
            ],
        ]
        let payload = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        let framed = Data(("booted\n" + GuestReport.prefix).utf8) + payload + Data("\r\n".utf8)
        let monitor = GuestSerialMonitor(spec: spec)
        var events: [GuestSerialMonitor.Event] = []
        var offset = 0
        let sizes = [1, 2, 7, 3, 19, 5, 64, 11]
        var chunk = 0
        while offset < framed.count {
            let size = sizes[chunk % sizes.count]
            let end = min(offset + size, framed.count)
            events += monitor.consume(framed.subdata(in: offset..<end))
            offset = end
            chunk += 1
        }
        #expect(offset == framed.count)
        #expect(framed.last == 10)
        #expect(events == [.diagnostic("booted"), .authenticReport])
    }

    @Test("rejects malformed report without retaining raw payload")
    func rejectsMalformedReport() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        let monitor = GuestSerialMonitor(spec: try fixture.decodeSpec())
        let events = monitor.consume(Data((GuestReport.prefix + "not-json\n").utf8))
        #expect(events == [.rejectedReport("json")])
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
            displayHeight: 900,
            machineIdentifierBase64: Data("machine-a".utf8).base64EncodedString()
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
            displayHeight: 900,
            machineIdentifierBase64: expected.machineIdentifierBase64
        )
        #expect(!store.hasCompleteState(wrong))

        let wrongMachine = ResumeMetadata(
            schemaVersion: expected.schemaVersion,
            bundleIdentity: expected.bundleIdentity,
            architecture: expected.architecture,
            cpuCount: expected.cpuCount,
            memoryBytes: expected.memoryBytes,
            displayWidth: expected.displayWidth,
            displayHeight: expected.displayHeight,
            machineIdentifierBase64: Data("machine-b".utf8).base64EncodedString()
        )
        #expect(!store.hasCompleteState(wrongMachine))
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

@Suite("Loopback helper API")
struct LocalAPITests {
    private let origin = "http://localhost:3000"
    private let challenge = String(repeating: "e", count: 64)

    @Test("parses one bounded HTTP request and rejects duplicate headers")
    func parsesBoundedRequest() throws {
        let request = try LocalHTTPRequest.parse(Data(
            "GET /v1/capabilities?challenge=\(challenge) HTTP/1.1\r\nOrigin: \(origin)\r\n\r\n".utf8
        ))
        #expect(request.method == "GET")
        #expect(request.headers["origin"] == origin)
        #expect(throws: HelperError.self) {
            try LocalHTTPRequest.parse(Data(
                "GET / HTTP/1.1\r\nOrigin: a\r\norigin: b\r\n\r\n".utf8
            ))
        }
        #expect(throws: HelperError.self) {
            try LocalHTTPRequest.parse(Data(
                "POST /v1/launch HTTP/1.1\r\nOrigin: \(origin)\r\n\r\n{}".utf8
            ))
        }
    }

    @Test("capability response binds origin, challenge, and exact guest")
    func capabilityBinding() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        let bundle = try GuestBundle.load(directory: fixture.root)
        let capabilities = HelperCapabilities(
            schemaVersion: 1,
            kind: "omarchy-native-helper",
            helperVersion: "0.1.0",
            hostArchitecture: "arm64",
            virtualizationAvailable: true,
            guestArchitectures: ["aarch64"],
            runtime: "apple-virtualization-framework",
            display: "native-window",
            supportsHostBoundResume: true
        )
        let response = LocalAPI.handle(
            request(method: "GET", target: "/v1/capabilities?challenge=\(challenge)"),
            allowedOrigin: origin,
            bundle: bundle,
            capabilities: capabilities,
            launch: { _ in Issue.record("GET must not launch"); return false }
        )
        #expect(response.status == 200)
        #expect(response.headers["Access-Control-Allow-Origin"] == origin)
        let envelope = try JSONDecoder().decode(NativeCapabilityEnvelope.self, from: response.body)
        #expect(envelope.challenge == challenge)
        #expect(envelope.virtualizationAvailable)
        #expect(envelope.guest.bundleIdentity == bundle.identity)
        #expect(envelope.guest.channel == "quattro")

        let rejectedOrigin = LocalAPI.handle(
            request(method: "GET", target: "/v1/capabilities?challenge=\(challenge)", origin: "https://evil.example"),
            allowedOrigin: origin,
            bundle: bundle,
            capabilities: capabilities,
            launch: { _ in false }
        )
        #expect(rejectedOrigin.status == 403)
        #expect(rejectedOrigin.headers["Access-Control-Allow-Origin"] == nil)

        let stale = LocalAPI.handle(
            request(method: "GET", target: "/v1/capabilities?challenge=short"),
            allowedOrigin: origin,
            bundle: bundle,
            capabilities: capabilities,
            launch: { _ in false }
        )
        #expect(stale.status == 400)
    }

    @Test("launch requires exact JSON and reports one accepted native window")
    func launchContract() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        let bundle = try GuestBundle.load(directory: fixture.root)
        var launches = 0
        let body = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "challenge": challenge,
        ], options: [.sortedKeys])
        let accepted = LocalAPI.handle(
            request(method: "POST", target: "/v1/launch", body: body),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { token in
                #expect(token == challenge)
                launches += 1
                return true
            }
        )
        #expect(accepted.status == 202)
        #expect(launches == 1)
        let envelope = try JSONDecoder().decode(NativeLaunchEnvelope.self, from: accepted.body)
        #expect(envelope.accepted)
        #expect(envelope.challenge == challenge)
        #expect(envelope.bundleIdentity == bundle.identity)

        let hostileBody = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "challenge": challenge,
            "command": "arbitrary",
        ], options: [.sortedKeys])
        let hostile = LocalAPI.handle(
            request(method: "POST", target: "/v1/launch", body: hostileBody),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in Issue.record("hostile POST must not launch"); return true }
        )
        #expect(hostile.status == 400)

        let conflict = LocalAPI.handle(
            request(method: "POST", target: "/v1/launch", body: body),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in false }
        )
        #expect(conflict.status == 409)
    }

    @Test("preflight is exact and credential-free")
    func preflight() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        let bundle = try GuestBundle.load(directory: fixture.root)
        let response = LocalAPI.handle(
            LocalHTTPRequest(
                method: "OPTIONS",
                target: "/v1/launch",
                headers: [
                    "origin": origin,
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "content-type",
                    "access-control-request-private-network": "true",
                ],
                body: Data()
            ),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in false }
        )
        #expect(response.status == 204)
        #expect(response.headers["Access-Control-Allow-Origin"] == origin)
        #expect(response.headers["Access-Control-Allow-Private-Network"] == "true")
        #expect(response.headers["Access-Control-Allow-Credentials"] == nil)

        let getResponse = LocalAPI.handle(
            LocalHTTPRequest(
                method: "OPTIONS",
                target: "/v1/capabilities?challenge=\(challenge)",
                headers: [
                    "origin": origin,
                    "access-control-request-method": "GET",
                    "access-control-request-private-network": "true",
                ],
                body: Data()
            ),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in false }
        )
        #expect(getResponse.status == 204)
        #expect(getResponse.headers["Access-Control-Allow-Private-Network"] == "true")

        let inputResponse = LocalAPI.handle(
            LocalHTTPRequest(
                method: "OPTIONS",
                target: "/v1/input",
                headers: [
                    "origin": origin,
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "content-type",
                    "access-control-request-private-network": "true",
                ],
                body: Data()
            ),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in false }
        )
        #expect(inputResponse.status == 204)
        #expect(inputResponse.headers["Access-Control-Allow-Private-Network"] == "true")
    }

    @Test("input requires the launch token and an exact bounded event")
    func inputContract() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try fixture.write()
        let bundle = try GuestBundle.load(directory: fixture.root)
        let event: [String: Any] = [
            "kind": "key",
            "sequence": 7,
            "code": "KeyA",
            "down": true,
        ]
        let body = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "sessionToken": challenge,
            "event": event,
        ], options: [.sortedKeys])
        var received: NativeRemoteInput?
        let accepted = LocalAPI.handle(
            request(method: "POST", target: "/v1/input", body: body),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in Issue.record("input must not launch"); return false },
            input: { token, value in
                #expect(token == challenge)
                received = value
                return true
            }
        )
        #expect(accepted.status == 202)
        #expect(received == .key(sequence: 7, code: "KeyA", down: true))
        #expect(try JSONDecoder().decode(NativeInputReceipt.self, from: accepted.body) ==
            NativeInputReceipt(schemaVersion: 1, accepted: true, sequence: 7))

        let unavailable = LocalAPI.handle(
            request(method: "POST", target: "/v1/input", body: body),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in false },
            input: { _, _ in false }
        )
        #expect(unavailable.status == 409)

        var hostileEvent = event
        hostileEvent["command"] = "open -a Calculator"
        let hostileBody = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "sessionToken": challenge,
            "event": hostileEvent,
        ], options: [.sortedKeys])
        let hostile = LocalAPI.handle(
            request(method: "POST", target: "/v1/input", body: hostileBody),
            allowedOrigin: origin,
            bundle: bundle,
            launch: { _ in false },
            input: { _, _ in Issue.record("malformed input must not be relayed"); return true }
        )
        #expect(hostile.status == 400)
    }

    private func request(
        method: String,
        target: String,
        origin: String? = nil,
        body: Data = Data()
    ) -> LocalHTTPRequest {
        var headers = ["origin": origin ?? self.origin]
        if method == "POST" { headers["content-type"] = "application/json" }
        return LocalHTTPRequest(method: method, target: target, headers: headers, body: body)
    }
}

@Suite("Native remote input")
struct NativeInputRelayTests {
    @Test("parser accepts exact browser events and rejects unknown keys")
    func parser() {
        #expect(NativeRemoteInput.parse([
            "kind": "pointer", "sequence": 1, "x": 0.25, "y": 0.75, "buttons": 1,
        ]) == .pointer(sequence: 1, x: 0.25, y: 0.75, buttons: 1))
        #expect(NativeRemoteInput.parse([
            "kind": "wheel", "sequence": 2, "deltaX": 0, "deltaY": 120,
        ]) == .wheel(sequence: 2, deltaX: 0, deltaY: 120))
        #expect(NativeRemoteInput.parse([
            "kind": "release-all", "sequence": 3,
        ]) == .releaseAll(sequence: 3))
        #expect(NativeRemoteInput.parse([
            "kind": "key", "sequence": 4, "code": "KeyA", "down": true, "extra": true,
        ]) == nil)
        #expect(NativeRemoteInput.parse([
            "kind": "key", "sequence": 4, "code": "Unknown", "down": true,
        ]) == nil)
    }

    @Test("relay posts key, pointer, wheel, and release events to one process")
    func postsEvents() {
        var posted: [(pid_t, CGEventType, CGPoint, Int64)] = []
        let relay = NativeInputRelay(
            postEvent: { event, processIdentifier in
                posted.append((
                    processIdentifier,
                    event.type,
                    event.location,
                    event.getIntegerValueField(.keyboardEventKeycode)
                ))
            },
            windowBounds: { _ in CGRect(x: 100, y: 200, width: 1600, height: 900) }
        )
        #expect(relay.send(.key(sequence: 1, code: "KeyA", down: true), to: 42))
        #expect(relay.send(.pointer(sequence: 2, x: 0.5, y: 0.5, buttons: 1), to: 42))
        #expect(relay.send(.wheel(sequence: 3, deltaX: 0, deltaY: 120), to: 42))
        #expect(relay.send(.releaseAll(sequence: 4), to: 42))
        #expect(posted.allSatisfy { $0.0 == 42 })
        #expect(posted.contains { $0.1 == .keyDown && $0.3 == 0 })
        #expect(posted.contains { $0.1 == .keyUp && $0.3 == 0 })
        #expect(posted.contains { $0.1 == .leftMouseDown })
        #expect(posted.contains { $0.1 == .leftMouseUp })
        #expect(posted.contains { $0.1 == .scrollWheel })
        #expect(posted.contains { $0.2 == CGPoint(x: 900, y: 650) })
    }
}
