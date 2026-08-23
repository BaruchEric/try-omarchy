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
