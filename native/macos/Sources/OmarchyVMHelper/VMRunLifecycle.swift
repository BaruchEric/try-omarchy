import Darwin
import Foundation

enum VMChildExitAction: Equatable {
    case relaunch
    case finish
}

struct VMRunLifecycle: Equatable {
    private enum StopIntent: Equatable {
        case none
        case restart
        case quit
        case signal(Int32)
    }

    private var stopIntent: StopIntent = .none

    var isRestarting: Bool {
        stopIntent == .restart
    }

    var isStopping: Bool {
        stopIntent != .none
    }

    mutating func requestRestart(allowed: Bool) -> Bool {
        guard allowed, stopIntent == .none else { return false }
        stopIntent = .restart
        return true
    }

    mutating func requestQuit() {
        // Quit always wins over a restart that is already draining the child.
        stopIntent = .quit
    }

    mutating func requestTermination(signal: Int32) {
        // An external termination request must never accidentally relaunch.
        stopIntent = .signal(signal)
    }

    mutating func childExited() -> VMChildExitAction {
        if stopIntent == .restart {
            stopIntent = .none
            return .relaunch
        }
        return .finish
    }
}
