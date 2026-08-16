import CryptoKit
import Foundation

enum Hashing {
    static func sha256(data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func sha256(fileAt url: URL) throws -> String {
        guard let stream = InputStream(url: url) else {
            throw HelperError.io("cannot open \(url.path)")
        }
        stream.open()
        defer { stream.close() }

        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw HelperError.io(stream.streamError?.localizedDescription ?? "read failed for \(url.path)")
            }
            if count == 0 { break }
            hasher.update(data: Data(buffer[0..<count]))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
