import CryptoKit
import Foundation
import Testing

@Suite("Caps Lock passthrough contract")
struct CapsLockPassthroughContractTests {
    @Test("Cocoa stops reconciling Caps Lock against its own record")
    func removesStateReconciliation() throws {
        let patch = try source(named: "patches/qemu-cocoa-caps-lock-passthrough.patch")

        let reconciliation = [
            "-    if (!!(modifiers & NSEventModifierFlagCapsLock) !=",
            "-        qkbd_state_modifier_get(kbd, QKBD_MOD_CAPSLOCK)) {",
            "-        qkbd_state_key_event(kbd, KEY_CAPSLOCK, true);",
            "-        qkbd_state_key_event(kbd, KEY_CAPSLOCK, false);",
            "-    }",
        ].joined(separator: "\n")
        #expect(patch.contains(reconciliation))
        #expect(patch.contains(
            "+     * NSEventModifierFlagCapsLock is deliberately not reconciled here."
        ))
    }

    @Test("Cocoa forwards Caps Lock as a key from the flags-changed switch")
    func forwardsKeyPress() throws {
        let patch = try source(named: "patches/qemu-cocoa-caps-lock-passthrough.patch")

        let passthrough = [
            "+                case kVK_CapsLock: {",
            "+                    static bool last_caps_lock_flag;",
            "+                    bool caps_lock_flag =",
            "+                        !!(modifiers & NSEventModifierFlagCapsLock);",
            "+",
            "+                    if (caps_lock_flag != last_caps_lock_flag) {",
            "+                        last_caps_lock_flag = caps_lock_flag;",
            "+                        qkbd_state_key_event(kbd, KEY_CAPSLOCK, true);",
            "+                        qkbd_state_key_event(kbd, KEY_CAPSLOCK, false);",
            "+                    }",
            "+                    break;",
            "+                }",
        ].joined(separator: "\n")
        #expect(patch.contains(passthrough))

        let switchEntry = try #require(patch.range(of: "switch ([event keyCode]) {"))
        let capsCase = try #require(patch.range(of: "+                case kVK_CapsLock: {"))
        let shiftCase = try #require(patch.range(of: "                case kVK_Shift:"))
        #expect(switchEntry.lowerBound < capsCase.lowerBound)
        #expect(capsCase.lowerBound < shiftCase.lowerBound)
    }

    /*
     * The lock flag stays set across the press and the release of the physical
     * key. Tapping on every Caps Lock event rather than on every change of the
     * flag sends two taps per press, which cancels itself out and leaves Caps
     * Lock inert in the guest.
     */
    @Test("Caps Lock taps on a change of the lock flag, not on every event")
    func tapsOnFlagChangeOnly() throws {
        let patch = try source(named: "patches/qemu-cocoa-caps-lock-passthrough.patch")

        let guarded = try #require(
            patch.range(of: "+                    if (caps_lock_flag != last_caps_lock_flag) {")
        )
        let firstTap = try #require(
            patch.range(of: "+                        qkbd_state_key_event(kbd, KEY_CAPSLOCK, true);")
        )
        #expect(guarded.lowerBound < firstTap.lowerBound)

        let addedLines = patch
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { $0.hasPrefix("+") }
        let taps = addedLines.filter { $0.contains("qkbd_state_key_event(kbd, KEY_CAPSLOCK,") }
        #expect(taps.count == 2)
    }

    @Test("Runtime build verifies and applies the patch after full grab")
    func buildScriptWiring() throws {
        let build = try source(named: "build-qemu-gpu-runtime.sh")

        #expect(build.contains(
            "caps_lock_patch=\"$native_dir/patches/qemu-cocoa-caps-lock-passthrough.patch\""
        ))
        #expect(build.contains("caps_lock_patch_sha256="))
        #expect(build.contains(
            "die \"missing Cocoa Caps Lock passthrough patch: $caps_lock_patch\""
        ))
        #expect(build.contains(
            "verify_file_sha \"Try Omarchy Cocoa Caps Lock passthrough patch\" \\\n" +
            "  \"$caps_lock_patch\" \"$caps_lock_patch_sha256\""
        ))

        let fullGrabApply = try #require(
            build.range(of: "patch -d \"$source_dir\" -p1 -f -i \"$full_grab_patch\"")
        )
        let capsApply = try #require(
            build.range(of: "patch -d \"$source_dir\" -p1 -f -i \"$caps_lock_patch\"")
        )
        #expect(fullGrabApply.lowerBound < capsApply.lowerBound)
    }

    @Test("Pinned hash matches the patch on disk")
    func pinnedHashMatches() throws {
        let build = try source(named: "build-qemu-gpu-runtime.sh")
        let patchData = try Data(contentsOf: macosDirectory().appendingPathComponent(
            "patches/qemu-cocoa-caps-lock-passthrough.patch"
        ))

        let pinned = try #require(
            build
                .split(separator: "\n")
                .first { $0.hasPrefix("caps_lock_patch_sha256=") }?
                .dropFirst("caps_lock_patch_sha256=".count)
        )
        #expect(String(pinned) == sha256Hex(patchData))
    }

    private func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func macosDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func source(named relativePath: String) throws -> String {
        try String(
            contentsOf: macosDirectory().appendingPathComponent(relativePath),
            encoding: .utf8
        )
    }
}
