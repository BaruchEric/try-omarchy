import Darwin
import Foundation

struct VMRunLifecycle: Equatable {
    private enum StopIntent: Equatable {
        case none
        case quit
        case signal(Int32)
    }

    private var stopIntent: StopIntent = .none

    var isStopping: Bool {
        stopIntent != .none
    }

    mutating func requestQuit() {
        stopIntent = .quit
    }

    mutating func requestTermination(signal: Int32) {
        stopIntent = .signal(signal)
    }

    mutating func childExited() {
        stopIntent = .none
    }
}

struct VMExitPresentationDecision: Equatable {
    let showsStartupFailure: Bool
    let requiresWorkspaceReset: Bool

    static let incompatibleWorkspaceStatus: Int32 = 78

    static func make(status: Int32, reachedVirtualMachineStart: Bool, wasStopping: Bool) -> Self {
        let requiresWorkspaceReset = status == incompatibleWorkspaceStatus
            && !reachedVirtualMachineStart
            && !wasStopping
        return Self(
            showsStartupFailure: status != 0
                && !reachedVirtualMachineStart
                && !wasStopping
                && !requiresWorkspaceReset,
            requiresWorkspaceReset: requiresWorkspaceReset
        )
    }
}
