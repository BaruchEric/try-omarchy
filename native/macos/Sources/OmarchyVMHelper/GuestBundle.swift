import Foundation

struct GuestBundle {
    static let requiredDevices = Set([
        "virtio-blk",
        "virtio-gpu",
        "usb-keyboard",
        "usb-screen-coordinate-pointing",
        "virtio-console",
        "virtio-rng",
        "virtio-balloon",
    ])

    let directory: URL
    let manifest: GuestArtifactManifest
    let spec: GuestBuildSpec
    let identity: String
    let kernelURL: URL
    let initramfsURL: URL
    let rootfsURL: URL

    static func load(directory: URL, verifyLargeDisk: Bool = true) throws -> GuestBundle {
        let manifestURL = directory.appendingPathComponent("guest-manifest.json")
        let specURL = directory.appendingPathComponent("build-spec.json")
        let decoder = JSONDecoder()

        let manifestData = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        let specData = try Data(contentsOf: specURL, options: [.mappedIfSafe])
        let manifest = try decoder.decode(GuestArtifactManifest.self, from: manifestData)
        let spec = try decoder.decode(GuestBuildSpec.self, from: specData)

        guard manifest.schemaVersion == 1, spec.schemaVersion == 1 else {
            throw HelperError.invalidBundle("unsupported manifest or spec schema")
        }
        guard manifest.guest.architecture == "aarch64", spec.image.architecture == "aarch64" else {
            throw HelperError.invalidBundle("native helper accepts only aarch64 guests")
        }
        guard spec.upstream.repository == "https://github.com/basecamp/omarchy",
              spec.upstream.channel == "quattro",
              spec.upstream.commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              spec.upstream.treeSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw HelperError.invalidBundle("untrusted or unpinned Quattro identity")
        }
        guard spec.runtime.hypervisor == "apple-virtualization-framework" else {
            throw HelperError.invalidBundle("runtime is not bound to Apple Virtualization.framework")
        }
        guard Set(spec.runtime.devices) == requiredDevices else {
            throw HelperError.invalidBundle("unexpected native virtual-device contract")
        }
        guard spec.guest.virtualDisplay.width == 1600,
              spec.guest.virtualDisplay.height == 900,
              spec.guest.virtualDisplay.scale == 1 else {
            throw HelperError.invalidBundle("display must be exact 1600x900 scale 1")
        }
        guard spec.runtime.kernelCommandLine.contains("console=hvc0") else {
            throw HelperError.invalidBundle("ARM serial console is not hvc0")
        }

        var records: [String: ArtifactRecord] = [:]
        for record in manifest.artifacts {
            guard records.updateValue(record, forKey: record.path) == nil else {
                throw HelperError.invalidBundle("duplicate artifact path")
            }
        }
        let required = ["build-spec.json", spec.runtime.kernel, spec.runtime.initramfs, spec.runtime.disk]
        for path in required {
            guard path == URL(fileURLWithPath: path).lastPathComponent,
                  let record = records[path] else {
                throw HelperError.invalidBundle("missing or unsafe artifact \(path)")
            }
            let file = directory.appendingPathComponent(path)
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            guard let size = attributes[.size] as? NSNumber,
                  size.uint64Value == record.bytes else {
                throw HelperError.invalidBundle("size mismatch for \(path)")
            }
            if path != spec.runtime.disk || verifyLargeDisk {
                guard try Hashing.sha256(fileAt: file) == record.sha256.lowercased() else {
                    throw HelperError.invalidBundle("SHA-256 mismatch for \(path)")
                }
            }
        }

        return GuestBundle(
            directory: directory,
            manifest: manifest,
            spec: spec,
            identity: Hashing.sha256(data: manifestData),
            kernelURL: directory.appendingPathComponent(spec.runtime.kernel),
            initramfsURL: directory.appendingPathComponent(spec.runtime.initramfs),
            rootfsURL: directory.appendingPathComponent(spec.runtime.disk)
        )
    }
}
