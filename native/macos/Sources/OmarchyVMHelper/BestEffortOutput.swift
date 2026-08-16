import Darwin
import Foundation

enum BestEffortOutput {
    typealias WriteCall = (Int32, UnsafeRawPointer, Int) -> Int

    @discardableResult
    static func write(
        _ data: Data,
        to descriptor: Int32,
        using writer: WriteCall = { descriptor, bytes, count in
            Darwin.write(descriptor, bytes, count)
        }
    ) -> Int {
        guard !data.isEmpty else { return 0 }
        return data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return 0 }
            var offset = 0
            while offset < rawBuffer.count {
                let result = writer(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    rawBuffer.count - offset
                )
                if result > 0 {
                    offset += min(result, rawBuffer.count - offset)
                    continue
                }
                if result == -1 && errno == EINTR {
                    continue
                }
                // Serial echo is diagnostic only. In particular, a full
                // nonblocking stdout must never terminate the VM or prevent
                // the same bytes from reaching the authenticated parser.
                break
            }
            return offset
        }
    }
}
