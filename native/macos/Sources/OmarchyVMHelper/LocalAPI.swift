import Foundation

struct LocalHTTPRequest: Equatable {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data

    static let maximumHeaderBytes = 16 * 1024
    static let maximumBodyBytes = 4 * 1024

    static func parse(_ data: Data) throws -> LocalHTTPRequest {
        let separator = Data("\r\n\r\n".utf8)
        guard let boundary = data.range(of: separator),
              boundary.lowerBound <= maximumHeaderBytes,
              let headerText = String(data: data[..<boundary.lowerBound], encoding: .utf8) else {
            throw HelperError.io("invalid or oversized HTTP headers")
        }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            throw HelperError.io("missing HTTP request line")
        }
        let requestParts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
        guard requestParts.count == 3,
              requestParts[2] == "HTTP/1.1",
              ["GET", "POST", "OPTIONS"].contains(String(requestParts[0])) else {
            throw HelperError.io("unsupported HTTP request line")
        }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else {
                throw HelperError.io("malformed HTTP header")
            }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, headers.updateValue(value, forKey: name) == nil else {
                throw HelperError.io("duplicate or empty HTTP header")
            }
        }
        guard let lengthText = headers["content-length"] ?? (requestParts[0] == "POST" ? nil : "0"),
              let contentLength = Int(lengthText),
              contentLength >= 0,
              contentLength <= maximumBodyBytes else {
            throw HelperError.io("invalid or oversized HTTP body")
        }
        let bodyStart = boundary.upperBound
        guard data.count == bodyStart + contentLength else {
            throw HelperError.io("HTTP body length mismatch")
        }
        return LocalHTTPRequest(
            method: String(requestParts[0]),
            target: String(requestParts[1]),
            headers: headers,
            body: data[bodyStart...]
        )
    }
}

struct LocalHTTPResponse {
    let status: Int
    let reason: String
    let headers: [String: String]
    let body: Data

    func serialized() -> Data {
        var fields = headers
        fields["Content-Length"] = String(body.count)
        fields["Connection"] = "close"
        let header = (["HTTP/1.1 \(status) \(reason)"] + fields.keys.sorted().map {
            "\($0): \(fields[$0]!)"
        }).joined(separator: "\r\n") + "\r\n\r\n"
        return Data(header.utf8) + body
    }
}

enum LocalAPI {
    static let capabilityPath = "/v1/capabilities"
    static let launchPath = "/v1/launch"
    static let inputPath = "/v1/input"
    static let challengePattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

    static func handle(
        _ request: LocalHTTPRequest,
        allowedOrigin: String,
        bundle: GuestBundle,
        capabilities: HelperCapabilities = HostCapabilities.report(),
        launch: (String) throws -> Bool,
        input: (String, NativeRemoteInput) -> Bool = { _, _ in false }
    ) -> LocalHTTPResponse {
        guard request.headers["origin"] == allowedOrigin else {
            return response(status: 403, reason: "Forbidden", body: ["error": "origin rejected"])
        }
        var cors = [
            "Access-Control-Allow-Origin": allowedOrigin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
            "Vary": "Origin",
        ]
        if request.headers["access-control-request-private-network"] == "true" {
            cors["Access-Control-Allow-Private-Network"] = "true"
        }

        if request.method == "OPTIONS" {
            let requestedMethod = request.headers["access-control-request-method"]
            let capabilityPreflight = requestedMethod == "GET"
                && URLComponents(string: "http://loopback\(request.target)")?.path == capabilityPath
                && request.headers["access-control-request-headers"] == nil
            let launchPreflight = requestedMethod == "POST"
                && [launchPath, inputPath].contains(request.target)
                && request.headers["access-control-request-headers"]?.lowercased() == "content-type"
            guard capabilityPreflight || launchPreflight else {
                return response(status: 403, reason: "Forbidden", headers: cors, body: ["error": "preflight rejected"])
            }
            return LocalHTTPResponse(status: 204, reason: "No Content", headers: cors, body: Data())
        }

        if request.method == "GET" {
            guard let components = URLComponents(string: "http://loopback\(request.target)"),
                  components.path == capabilityPath,
                  components.queryItems?.count == 1,
                  components.queryItems?.first?.name == "challenge",
                  let challenge = components.queryItems?.first?.value,
                  isChallenge(challenge),
                  request.body.isEmpty else {
                return response(status: 400, reason: "Bad Request", headers: cors, body: ["error": "capability challenge rejected"])
            }
            let envelope = NativeCapabilityEnvelope(
                schemaVersion: capabilities.schemaVersion,
                kind: capabilities.kind,
                helperVersion: capabilities.helperVersion,
                challenge: challenge,
                hostArchitecture: capabilities.hostArchitecture,
                virtualizationAvailable: capabilities.virtualizationAvailable,
                guestArchitectures: capabilities.guestArchitectures,
                runtime: capabilities.runtime,
                display: capabilities.display,
                supportsHostBoundResume: capabilities.supportsHostBoundResume,
                guest: nativeGuestIdentity(bundle)
            )
            return encodableResponse(status: 200, reason: "OK", headers: cors, value: envelope)
        }

        guard request.method == "POST",
              [launchPath, inputPath].contains(request.target),
              request.headers["content-type"]?.lowercased() == "application/json",
              let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
            return response(status: 400, reason: "Bad Request", headers: cors, body: ["error": "request rejected"])
        }

        if request.target == inputPath {
            guard Set(object.keys) == Set(["schemaVersion", "sessionToken", "event"]),
                  object["schemaVersion"] as? Int == 1,
                  let sessionToken = object["sessionToken"] as? String,
                  isChallenge(sessionToken),
                  let event = NativeRemoteInput.parse(object["event"] as Any) else {
                return response(status: 400, reason: "Bad Request", headers: cors, body: ["error": "input request rejected"])
            }
            guard input(sessionToken, event) else {
                return response(status: 409, reason: "Conflict", headers: cors, body: ["error": "native VM input unavailable"])
            }
            return encodableResponse(
                status: 202,
                reason: "Accepted",
                headers: cors,
                value: NativeInputReceipt(schemaVersion: 1, accepted: true, sequence: event.sequence)
            )
        }

        guard
              Set(object.keys) == Set(["schemaVersion", "challenge"]),
              object["schemaVersion"] as? Int == 1,
              let challenge = object["challenge"] as? String,
              isChallenge(challenge) else {
            return response(status: 400, reason: "Bad Request", headers: cors, body: ["error": "launch request rejected"])
        }
        do {
            guard try launch(challenge) else {
                return response(status: 409, reason: "Conflict", headers: cors, body: ["error": "native VM is already running"])
            }
            return encodableResponse(
                status: 202,
                reason: "Accepted",
                headers: cors,
                value: NativeLaunchEnvelope(
                    schemaVersion: 1,
                    accepted: true,
                    challenge: challenge,
                    bundleIdentity: bundle.identity,
                    architecture: "aarch64",
                    display: "native-window"
                )
            )
        } catch {
            return response(status: 500, reason: "Internal Server Error", headers: cors, body: ["error": "native VM launch failed"])
        }
    }

    private static func nativeGuestIdentity(_ bundle: GuestBundle) -> NativeGuestIdentity {
        NativeGuestIdentity(
            architecture: bundle.spec.image.architecture,
            channel: bundle.spec.upstream.channel ?? "",
            repository: bundle.spec.upstream.repository,
            commit: bundle.spec.upstream.commit,
            version: bundle.spec.upstream.version,
            treeSha256: bundle.spec.upstream.treeSha256,
            bundleIdentity: bundle.identity
        )
    }

    private static func isChallenge(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return challengePattern.firstMatch(in: value, range: range)?.range == range
    }

    private static func encodableResponse<T: Encodable>(
        status: Int,
        reason: String,
        headers: [String: String],
        value: T
    ) -> LocalHTTPResponse {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return LocalHTTPResponse(status: status, reason: reason, headers: headers, body: try! encoder.encode(value))
    }

    private static func response(
        status: Int,
        reason: String,
        headers: [String: String] = ["Content-Type": "application/json", "Cache-Control": "no-store"],
        body: [String: String]
    ) -> LocalHTTPResponse {
        encodableResponse(status: status, reason: reason, headers: headers, value: body)
    }
}
