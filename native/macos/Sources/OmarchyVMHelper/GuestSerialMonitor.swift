import Foundation

final class GuestSerialMonitor: @unchecked Sendable {
    enum Event: Equatable {
        case diagnostic(String)
        case authenticReport
        case rejectedReport(String)
    }

    private let spec: GuestBuildSpec
    private let lock = NSLock()
    private var buffer = Data()

    init(spec: GuestBuildSpec) {
        self.spec = spec
    }

    func consume(_ data: Data) -> [Event] {
        lock.lock()
        defer { lock.unlock() }

        buffer.append(data)
        var events: [Event] = []
        while let newline = buffer.firstIndex(of: 0x0a) {
            let line = String(decoding: buffer[..<newline], as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(...newline)
            if line.hasPrefix(GuestReport.prefix) {
                if let reason = GuestReport.rejectionReason(line: line, spec: spec) {
                    events.append(.rejectedReport(reason))
                } else {
                    events.append(.authenticReport)
                }
            } else if !line.isEmpty {
                events.append(.diagnostic(String(line.prefix(8 * 1024))))
            }
        }
        if buffer.count > 512 * 1024 {
            buffer = Data(buffer.suffix(64 * 1024))
        }
        return events
    }
}
