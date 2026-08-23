import Foundation
import Testing
@testable import OmarchyVMHelper

@Suite("Host audio routing")
struct AudioDevicesTests {
    @Test("empty preferences use System Default for both directions")
    func emptyPreferencesUseSystemDefaults() {
        let fixture = DefaultsFixture()
        defer { fixture.cleanUp() }

        #expect(fixture.store.load() == .systemDefaults)
    }

    @Test("speaker and microphone UIDs persist together across a relaunch")
    func preferencesRoundTrip() {
        let fixture = DefaultsFixture()
        defer { fixture.cleanUp() }
        let expected = AudioRoutingPreferences(
            output: .device(uid: "output-uid", lastKnownName: "Studio Display"),
            input: .device(uid: "input-uid", lastKnownName: "Desk Microphone")
        )

        fixture.store.save(expected)
        let reopened = AudioRoutingPreferenceStore(defaults: fixture.defaults)

        #expect(reopened.load() == expected)
        #expect(fixture.defaults.data(forKey: AudioRoutingPreferenceStore.key) != nil)
    }

    @Test("updating one direction preserves the other direction")
    func directionUpdatesAreAtomic() {
        let fixture = DefaultsFixture()
        defer { fixture.cleanUp() }
        fixture.store.save(AudioRoutingPreferences(
            output: .device(uid: "speaker", lastKnownName: "Speaker"),
            input: .device(uid: "microphone", lastKnownName: "Microphone")
        ))

        fixture.store.set(.systemDefault, for: .input)

        #expect(fixture.store.load() == AudioRoutingPreferences(
            output: .device(uid: "speaker", lastKnownName: "Speaker"),
            input: .systemDefault
        ))
    }

    @Test("corrupt and future preference schemas fail safely without rewriting data")
    func invalidPreferencesFailSafely() throws {
        let fixture = DefaultsFixture()
        defer { fixture.cleanUp() }
        let future = try #require(
            """
            {"schemaVersion":99,"output":{"kind":"systemDefault"},"input":{"kind":"systemDefault"}}
            """.data(using: .utf8)
        )
        fixture.defaults.set(future, forKey: AudioRoutingPreferenceStore.key)

        #expect(fixture.store.load() == .systemDefaults)
        #expect(fixture.defaults.data(forKey: AudioRoutingPreferenceStore.key) == future)

        let corrupt = Data("not-json".utf8)
        fixture.defaults.set(corrupt, forKey: AudioRoutingPreferenceStore.key)
        #expect(fixture.store.load() == .systemDefaults)
        #expect(fixture.defaults.data(forKey: AudioRoutingPreferenceStore.key) == corrupt)
    }

    @Test("SDL duplicate suffixes are recreated independently by direction")
    func recreatesSDLNames() {
        let catalog = HostAudioDeviceCatalog.make(from: [
            .init(uid: "a", outputName: "Display Audio", inputName: "Desk Mic"),
            .init(uid: "b", outputName: "Display Audio ", inputName: "Desk Mic"),
            .init(uid: "c", outputName: nil, inputName: "Camera Mic"),
        ])

        #expect(catalog.device(uid: "a", direction: .output)?.sdlName == "Display Audio")
        #expect(catalog.device(uid: "b", direction: .output)?.sdlName == "Display Audio (2)")
        #expect(catalog.device(uid: "a", direction: .input)?.sdlName == "Desk Mic")
        #expect(catalog.device(uid: "b", direction: .input)?.sdlName == "Desk Mic (2)")
        #expect(catalog.device(uid: "c", direction: .output) == nil)
        #expect(catalog.device(uid: "c", direction: .input)?.sdlName == "Camera Mic")
    }

    @Test("an unavailable saved UID uses effective default without losing the preference")
    func unavailableSelectionFallsBack() {
        let fixture = DefaultsFixture()
        defer { fixture.cleanUp() }
        let preferences = AudioRoutingPreferences(
            output: .device(uid: "disconnected", lastKnownName: "Travel Headphones"),
            input: .systemDefault
        )
        fixture.store.save(preferences)

        let configuration = AudioLaunchConfiguration.make(
            baseEnvironment: [:],
            preferences: fixture.store.load(),
            catalog: .empty
        )

        #expect(configuration.routes.outputSDLName == nil)
        #expect(configuration.environment[AudioLaunchConfiguration.outputDeviceNameKey] == nil)
        #expect(fixture.store.load() == preferences)
    }

    @Test("launch environment selects input and output independently and removes SDL override")
    func createsSanitizedEnvironment() {
        let catalog = HostAudioDeviceCatalog.make(from: [
            .init(uid: "speaker", outputName: "External Speaker", inputName: nil),
            .init(uid: "microphone", outputName: nil, inputName: "USB Microphone"),
        ])
        let preferences = AudioRoutingPreferences(
            output: .device(uid: "speaker", lastKnownName: "External Speaker"),
            input: .device(uid: "microphone", lastKnownName: "USB Microphone")
        )
        let configuration = AudioLaunchConfiguration.make(
            baseEnvironment: [
                "KEEP_ME": "yes",
                AudioLaunchConfiguration.inheritedSDLDeviceNameKey: "global override",
                AudioLaunchConfiguration.outputDeviceNameKey: "stale output",
                AudioLaunchConfiguration.inputDeviceNameKey: "stale input",
            ],
            preferences: preferences,
            catalog: catalog
        )

        #expect(configuration.environment["KEEP_ME"] == "yes")
        #expect(configuration.environment[AudioLaunchConfiguration.inheritedSDLDeviceNameKey] == nil)
        #expect(configuration.environment[AudioLaunchConfiguration.outputDeviceNameKey] == "External Speaker")
        #expect(configuration.environment[AudioLaunchConfiguration.inputDeviceNameKey] == "USB Microphone")
    }

    @Test("System Default emits no explicit device variables")
    func systemDefaultEmitsNoDeviceNames() {
        let configuration = AudioLaunchConfiguration.make(
            baseEnvironment: [
                AudioLaunchConfiguration.inheritedSDLDeviceNameKey: "override",
                AudioLaunchConfiguration.outputDeviceNameKey: "old output",
                AudioLaunchConfiguration.inputDeviceNameKey: "old input",
            ],
            preferences: .systemDefaults,
            catalog: .empty
        )

        #expect(configuration.routes == ResolvedAudioRoutes(
            outputSDLName: nil,
            inputSDLName: nil
        ))
        #expect(configuration.environment.isEmpty)
    }

    private final class DefaultsFixture {
        let suiteName = "dev.tryomarchy.native.tests.\(UUID().uuidString)"
        let defaults: UserDefaults
        let store: AudioRoutingPreferenceStore

        init() {
            defaults = UserDefaults(suiteName: suiteName)!
            defaults.removePersistentDomain(forName: suiteName)
            store = AudioRoutingPreferenceStore(defaults: defaults)
        }

        func cleanUp() {
            defaults.removePersistentDomain(forName: suiteName)
        }
    }
}

@Suite("VM run lifecycle")
struct VMRunLifecycleTests {
    @Test("one accepted restart produces exactly one relaunch")
    func restartOnce() {
        var lifecycle = VMRunLifecycle()

        let accepted = lifecycle.requestRestart(allowed: true)
        #expect(accepted)
        #expect(lifecycle.isRestarting)
        let firstExit = lifecycle.childExited()
        #expect(firstExit == .relaunch)
        #expect(!lifecycle.isStopping)
        let secondExit = lifecycle.childExited()
        #expect(secondExit == .finish)
    }

    @Test("a denied restart leaves the VM running")
    func deniedRestart() {
        var lifecycle = VMRunLifecycle()

        let accepted = lifecycle.requestRestart(allowed: false)
        #expect(!accepted)
        #expect(!lifecycle.isStopping)
        let exit = lifecycle.childExited()
        #expect(exit == .finish)
    }

    @Test("Quit overrides a pending restart")
    func quitOverridesRestart() {
        var lifecycle = VMRunLifecycle()
        let accepted = lifecycle.requestRestart(allowed: true)
        #expect(accepted)

        lifecycle.requestQuit()

        let exit = lifecycle.childExited()
        #expect(exit == .finish)
    }

    @Test("an external signal cancels a pending restart")
    func signalOverridesRestart() {
        var lifecycle = VMRunLifecycle()
        let accepted = lifecycle.requestRestart(allowed: true)
        #expect(accepted)

        lifecycle.requestTermination(signal: 15)

        let exit = lifecycle.childExited()
        #expect(exit == .finish)
    }
}
