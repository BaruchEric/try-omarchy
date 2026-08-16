import Darwin
import Foundation

struct ResumeStore {
    let root: URL

    init(root: URL? = nil) throws {
        if let root {
            self.root = root
        } else {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            self.root = support.appendingPathComponent("OmarchyVMHelper/Resume", isDirectory: true)
        }
        try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    func directory(for identity: String) -> URL {
        root.appendingPathComponent(identity, isDirectory: true)
    }

    func metadata(for identity: String) -> ResumeMetadata? {
        let url = directory(for: identity).appendingPathComponent("metadata.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ResumeMetadata.self, from: data)
    }

    func stateURL(for identity: String) -> URL {
        directory(for: identity).appendingPathComponent("machine.state")
    }

    func diskURL(for identity: String) -> URL {
        directory(for: identity).appendingPathComponent("rootfs.ext4")
    }

    func hasCompleteState(_ expected: ResumeMetadata) -> Bool {
        metadata(for: expected.bundleIdentity) == expected
            && FileManager.default.fileExists(atPath: stateURL(for: expected.bundleIdentity).path)
            && FileManager.default.fileExists(atPath: diskURL(for: expected.bundleIdentity).path)
    }

    static func cloneFile(from source: URL, to destination: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if manager.fileExists(atPath: destination.path) {
            try manager.removeItem(at: destination)
        }
        if clonefile(source.path, destination.path, 0) == 0 { return }
        do {
            try manager.copyItem(at: source, to: destination)
        } catch {
            throw HelperError.io("cannot clone disposable disk: \(error.localizedDescription)")
        }
    }
}
