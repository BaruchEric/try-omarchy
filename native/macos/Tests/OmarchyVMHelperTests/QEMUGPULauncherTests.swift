import Darwin
import Foundation
import Testing
@testable import OmarchyVMHelper

@Suite("QEMU GPU app launch request")
struct QEMUGPULaunchRequestTests {
    @Test("accepts only the launcher storage flags and an optional absolute guest directory")
    func parsesAllowedArguments() {
        let guest = "/private/tmp/omarchy guest"
        #expect(QEMUGPULaunchRequest(arguments: []) == QEMUGPULaunchRequest(
            storageOption: nil,
            guestDirectoryPath: nil
        ))
        #expect(QEMUGPULaunchRequest(arguments: ["--ephemeral"]) == QEMUGPULaunchRequest(
            storageOption: .ephemeral,
            guestDirectoryPath: nil
        ))
        #expect(QEMUGPULaunchRequest(arguments: ["--reset-storage", guest]) == QEMUGPULaunchRequest(
            storageOption: .resetStorage,
            guestDirectoryPath: guest
        ))
        #expect(QEMUGPULaunchRequest(arguments: [guest]) == QEMUGPULaunchRequest(
            storageOption: nil,
            guestDirectoryPath: guest
        ))
    }

    @Test("rejects unknown flags, relative paths, reordered flags, and extra arguments")
    func rejectsUnsafeArguments() {
        for arguments in [
            ["--unknown"],
            ["relative/guest"],
            ["/guest", "--ephemeral"],
            ["--ephemeral", "--reset-storage"],
            ["--ephemeral", "/guest", "/other"],
            ["/guest\nother"],
        ] {
            #expect(QEMUGPULaunchRequest(arguments: arguments) == nil)
        }
    }

    @Test("canonicalizes a safe guest directory before passing it to the script")
    func validatesGuestDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omarchy-qemu-request-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let request = try #require(QEMUGPULaunchRequest(arguments: ["--ephemeral", root.path]))
        #expect(try request.validatedScriptArguments() == ["--ephemeral", root.resolvingSymlinksInPath().path])
    }

    @Test("rejects a final guest-directory symlink")
    func rejectsGuestSymlink() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omarchy-qemu-request-\(UUID().uuidString)", isDirectory: true)
        let guest = root.appendingPathComponent("guest", isDirectory: true)
        let link = root.appendingPathComponent("guest-link", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: guest, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: guest)

        let request = try #require(QEMUGPULaunchRequest(arguments: [link.path]))
        #expect(throws: HelperError.self) {
            try request.validatedScriptArguments()
        }
    }

}

@Suite("Bundled QEMU GPU launcher path")
struct QEMUGPULauncherPathTests {
    @Test("resolves only the executable inside the app resources")
    func resolvesExpectedLayout() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        #expect(try QEMUGPULauncherPath.resolve(bundleURL: fixture.app) == fixture.launcher)
    }

    @Test("rejects a launcher symlink")
    func rejectsLauncherSymlink() throws {
        let fixture = try makeFixture(createLauncher: false)
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let other = fixture.root.appendingPathComponent("other-launcher")
        try Data("#!/bin/bash\nexit 0\n".utf8).write(to: other)
        #expect(Darwin.chmod(other.path, 0o755) == 0)
        try FileManager.default.createSymbolicLink(at: fixture.launcher, withDestinationURL: other)

        #expect(throws: HelperError.self) {
            try QEMUGPULauncherPath.resolve(bundleURL: fixture.app)
        }
    }

    @Test("rejects an app with the wrong bundle name")
    func rejectsWrongBundleName() throws {
        let fixture = try makeFixture(appName: "Other.app")
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        #expect(throws: HelperError.self) {
            try QEMUGPULauncherPath.resolve(bundleURL: fixture.app)
        }
    }

    private struct PathFixture {
        let root: URL
        let app: URL
        let launcher: URL
    }

    private func makeFixture(
        appName: String = QEMUGPULauncherPath.appName,
        createLauncher: Bool = true
    ) throws -> PathFixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("omarchy-qemu-path-\(UUID().uuidString)", isDirectory: true)
        let app = root.appendingPathComponent(appName, isDirectory: true)
        let scripts = app
            .appendingPathComponent("Contents/Resources/scripts", isDirectory: true)
        let launcher = scripts.appendingPathComponent(QEMUGPULauncherPath.launcherName)
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)
        if createLauncher {
            try Data("#!/bin/bash\nexit 0\n".utf8).write(to: launcher)
            #expect(Darwin.chmod(launcher.path, 0o755) == 0)
        }
        return PathFixture(
            root: root,
            app: app.resolvingSymlinksInPath(),
            launcher: launcher.resolvingSymlinksInPath()
        )
    }
}

@Suite("Microphone launch policy")
struct MicrophoneLaunchDecisionTests {
    @Test("denial keeps playback launchable and gives recovery instructions")
    func deniedStillLaunches() {
        let decision = MicrophoneLaunchDecision.make(for: .denied)
        #expect(decision.allowsLaunch)
        #expect(decision.warning?.contains("Audio playback will continue") == true)
        #expect(decision.warning?.contains("System Settings > Privacy & Security > Microphone") == true)
    }

    @Test("restriction keeps playback launchable with an administrator action")
    func restrictedStillLaunches() {
        let decision = MicrophoneLaunchDecision.make(for: .restricted)
        #expect(decision.allowsLaunch)
        #expect(decision.warning?.contains("Mac administrator") == true)
    }

    @Test("authorization launches without a warning")
    func authorizedHasNoWarning() {
        let decision = MicrophoneLaunchDecision.make(for: .authorized)
        #expect(decision.allowsLaunch)
        #expect(decision.warning == nil)
    }
}
