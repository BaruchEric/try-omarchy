import Foundation

enum GuestReport {
    static let prefix = "OMARCHY_GUEST_REPORT "

    static func rejectionReason(line: String, spec: GuestBuildSpec) -> String? {
        guard line.hasPrefix(prefix) else { return "prefix" }
        guard let data = String(line.dropFirst(prefix.count)).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return "json" }
        guard object["schemaVersion"] as? Int == 1 else { return "schema" }
        guard let provenance = object["provenance"] as? [String: Any],
              provenance["repository"] as? String == spec.upstream.repository,
              provenance["commit"] as? String == spec.upstream.commit,
              provenance["version"] as? String == spec.upstream.version,
              provenance["treeSha256"] as? String == spec.upstream.treeSha256
        else { return "provenance" }
        guard let system = object["system"] as? [String: Any],
              system["architecture"] as? String == "aarch64",
              system["distribution"] as? String == "Arch Linux",
              system["sessionType"] as? String == "wayland"
        else { return "system" }
        guard let components = object["components"] as? [[String: Any]] else {
            return "components"
        }
        var roles: [String: String] = [:]
        for component in components {
            guard let role = component["role"] as? String,
                  let name = component["name"] as? String,
                  roles.updateValue(name.lowercased(), forKey: role) == nil else {
                return "components"
            }
        }
        guard roles["compositor"] == "hyprland", roles["shell"] == "quickshell" else {
            return "components"
        }
        return nil
    }

    static func authentic(line: String, spec: GuestBuildSpec) -> Bool {
        rejectionReason(line: line, spec: spec) == nil
    }
}
