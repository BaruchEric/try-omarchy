import Darwin
import Foundation

final class NativeVMLauncher: @unchecked Sendable {
    private static let maximumSessionSeconds: TimeInterval = 30 * 60
    private let lock = NSLock()
    private let executableURL: URL
    private let bundleDirectory: URL
    private let inputRelay: NativeInputRelay
    private let streamWindow: Bool
    private var child: Process?
    private var sessionToken: String?

    init(
        executableURL: URL,
        bundleDirectory: URL,
        streamWindow: Bool = false,
        inputRelay: NativeInputRelay = NativeInputRelay()
    ) {
        self.executableURL = executableURL
        self.bundleDirectory = bundleDirectory
        self.streamWindow = streamWindow
        self.inputRelay = inputRelay
    }

    func launch(sessionToken: String) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if child?.isRunning == true { return false }
        inputRelay.reset()

        let process = Process()
        process.executableURL = executableURL
        process.arguments = ["--run", bundleDirectory.path] + (streamWindow ? ["--stream-window"] : [])
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { [weak self, weak process] _ in
            guard let self, let process else { return }
            self.lock.lock()
            if self.child === process {
                self.inputRelay.reset()
                self.child = nil
                self.sessionToken = nil
            }
            self.lock.unlock()
        }
        try process.run()
        child = process
        self.sessionToken = sessionToken
        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + Self.maximumSessionSeconds
        ) { [weak self, weak process] in
            guard let process else { return }
            self?.expire(process)
        }
        return true
    }

    func sendInput(sessionToken: String, event: NativeRemoteInput) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let child, child.isRunning, self.sessionToken == sessionToken else { return false }
        return inputRelay.send(event, to: child.processIdentifier)
    }

    func stop(sessionToken: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let child, child.isRunning, self.sessionToken == sessionToken else { return false }
        inputRelay.releaseAll(to: child.processIdentifier)
        inputRelay.reset()
        self.sessionToken = nil
        child.terminate()
        return true
    }

    func stopAny() {
        lock.lock()
        defer { lock.unlock() }
        guard let child, child.isRunning else {
            inputRelay.reset()
            self.child = nil
            sessionToken = nil
            return
        }
        inputRelay.releaseAll(to: child.processIdentifier)
        inputRelay.reset()
        sessionToken = nil
        child.terminate()
    }

    private func expire(_ process: Process) {
        lock.lock()
        defer { lock.unlock() }
        guard child === process, process.isRunning else { return }
        inputRelay.releaseAll(to: process.processIdentifier)
        inputRelay.reset()
        sessionToken = nil
        process.terminate()
    }
}

enum LoopbackServer {
    static let defaultPort: UInt16 = 11555

    static func serve(
        port: UInt16,
        allowedOrigin: String,
        bundle: GuestBundle,
        launcher: NativeVMLauncher
    ) throws -> Never {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw HelperError.io("cannot create loopback socket") }
        defer { Darwin.close(descriptor) }

        var reuse: Int32 = 1
        guard setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse))) == 0 else {
            throw HelperError.io("cannot configure loopback socket")
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(descriptor, 8) == 0 else {
            throw HelperError.io("cannot bind 127.0.0.1:\(port)")
        }
        print("[native] Helper API listening on http://127.0.0.1:\(port) for \(allowedOrigin)")

        while true {
            let client = Darwin.accept(descriptor, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                throw HelperError.io("loopback accept failed")
            }
            autoreleasepool {
                defer { Darwin.close(client) }
                var noSigPipe: Int32 = 1
                _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout.size(ofValue: noSigPipe)))
                let response: LocalHTTPResponse
                do {
                    let request = try LocalHTTPRequest.parse(readRequest(client))
                    response = LocalAPI.handle(
                        request,
                        allowedOrigin: allowedOrigin,
                        bundle: bundle,
                        launch: { token in try launcher.launch(sessionToken: token) },
                        input: { token, event in launcher.sendInput(sessionToken: token, event: event) },
                        stop: { token in launcher.stop(sessionToken: token) }
                    )
                } catch {
                    response = LocalHTTPResponse(
                        status: 400,
                        reason: "Bad Request",
                        headers: ["Content-Type": "application/json", "Cache-Control": "no-store"],
                        body: Data("{\"error\":\"invalid request\"}".utf8)
                    )
                }
                writeAll(response.serialized(), to: client)
            }
        }
    }

    private static func readRequest(_ descriptor: Int32) throws -> Data {
        let separator = Data("\r\n\r\n".utf8)
        var data = Data()
        var contentLength: Int?
        var buffer = [UInt8](repeating: 0, count: 4096)
        while data.count <= LocalHTTPRequest.maximumHeaderBytes + LocalHTTPRequest.maximumBodyBytes + separator.count {
            let count = Darwin.recv(descriptor, &buffer, buffer.count, 0)
            guard count > 0 else { throw HelperError.io("incomplete HTTP request") }
            data.append(buffer, count: count)
            if contentLength == nil, let boundary = data.range(of: separator) {
                guard boundary.lowerBound <= LocalHTTPRequest.maximumHeaderBytes,
                      let text = String(data: data[..<boundary.lowerBound], encoding: .utf8) else {
                    throw HelperError.io("invalid HTTP headers")
                }
                let lines = text.components(separatedBy: "\r\n")
                contentLength = lines
                    .dropFirst()
                    .first { $0.lowercased().hasPrefix("content-length:") }
                    .flatMap { Int($0.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                if lines.first?.hasPrefix("POST ") == true,
                   !lines.dropFirst().contains(where: { $0.lowercased().hasPrefix("content-length:") }) {
                    throw HelperError.io("POST requires Content-Length")
                }
                guard contentLength! <= LocalHTTPRequest.maximumBodyBytes else {
                    throw HelperError.io("HTTP body too large")
                }
                if data.count == boundary.upperBound + contentLength! { return data }
                if data.count > boundary.upperBound + contentLength! {
                    throw HelperError.io("HTTP body exceeds Content-Length")
                }
            } else if let contentLength, let boundary = data.range(of: separator),
                      data.count == boundary.upperBound + contentLength {
                return data
            }
        }
        throw HelperError.io("HTTP request too large")
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < data.count {
                let count = Darwin.send(descriptor, base.advanced(by: offset), data.count - offset, 0)
                if count <= 0 { return }
                offset += count
            }
        }
    }
}
