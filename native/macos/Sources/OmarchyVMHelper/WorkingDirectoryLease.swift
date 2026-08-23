import Darwin
import Foundation

struct WorkingDirectoryCleanupReport: Equatable {
    var removed: [String] = []
    var active: [String] = []
    var legacy: [String] = []
    var unsafe: [String] = []
}

/// Owns one disposable VM disk directory for exactly as long as its helper
/// process is alive. The advisory lock is released by the kernel even after a
/// crash or SIGKILL, allowing a later helper to reclaim the abandoned clone.
final class WorkingDirectoryLease {
    static let workPrefix = "omarchy-native-"
    static let claimPrefix = ".omarchy-native-claim-"
    static let lockName = ".owner.lock"
    static let diskName = "rootfs.ext4"
    static let lockMarker = Data("omarchy-native-workdir-v1\n".utf8)

    let directory: URL

    private let manager: FileManager
    private var lockDescriptor: Int32

    init(
        root: URL = FileManager.default.temporaryDirectory,
        identifier: UUID = UUID(),
        cleanStaleDirectories: Bool = true,
        manager: FileManager = .default
    ) throws {
        self.manager = manager

        if cleanStaleDirectories {
            let report = Self.cleanupStaleDirectories(in: root, manager: manager)
            if !report.removed.isEmpty {
                print("[native] Removed \(report.removed.count) abandoned disposable VM disk(s)")
            }
            if !report.legacy.isEmpty {
                fputs(
                    "[native] Left \(report.legacy.count) unverifiable legacy VM temp director\(report.legacy.count == 1 ? "y" : "ies") untouched.\n",
                    stderr
                )
            }
        }

        let suffix = identifier.uuidString.uppercased()
        let claim = root.appendingPathComponent(Self.claimPrefix + suffix, isDirectory: true)
        let final = root.appendingPathComponent(Self.workPrefix + suffix, isDirectory: true)
        var descriptor: Int32 = -1

        do {
            try manager.createDirectory(
                at: claim,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            descriptor = Darwin.open(
                claim.appendingPathComponent(Self.lockName).path,
                O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                S_IRUSR | S_IWUSR
            )
            guard descriptor >= 0 else {
                throw HelperError.io("cannot create disposable VM ownership lock")
            }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                throw HelperError.io("cannot acquire disposable VM ownership lock")
            }
            try Self.writeMarker(to: descriptor)

            // Only expose the normal work-directory prefix after the lock is
            // held. A concurrent helper can therefore never mistake a newly
            // created, not-yet-locked directory for abandoned work.
            try manager.moveItem(at: claim, to: final)
        } catch {
            if descriptor >= 0 {
                _ = flock(descriptor, LOCK_UN)
                Darwin.close(descriptor)
            }
            try? manager.removeItem(at: claim)
            throw error
        }

        directory = final
        lockDescriptor = descriptor
    }

    deinit {
        cleanup()
    }

    func cleanup() {
        guard lockDescriptor >= 0 else { return }
        let descriptor = lockDescriptor
        lockDescriptor = -1

        // Refuse to remove a path that no longer contains the exact lock file
        // represented by our open descriptor. This protects against a renamed
        // or replaced directory even though the UUID name is unpredictable.
        if Self.directory(directory, ownsLock: descriptor, manager: manager) {
            try? manager.removeItem(at: directory)
        }
        _ = flock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
    }

    static func cleanupStaleDirectories(
        in root: URL = FileManager.default.temporaryDirectory,
        manager: FileManager = .default
    ) -> WorkingDirectoryCleanupReport {
        var report = WorkingDirectoryCleanupReport()
        guard let candidates = try? manager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil,
            options: []
        ) else {
            return report
        }

        for candidate in candidates {
            let name = candidate.lastPathComponent
            guard isOwnedCandidateName(name), isOwnedDirectory(candidate) else { continue }
            let lockURL = candidate.appendingPathComponent(lockName)
            let descriptor = Darwin.open(lockURL.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
            if descriptor < 0 {
                if errno == ENOENT {
                    // Helpers predating ownership locks may still be running.
                    // Age and PID checks cannot prove otherwise, so never
                    // remove those directories automatically.
                    report.legacy.append(name)
                } else {
                    report.unsafe.append(name)
                }
                continue
            }
            defer { Darwin.close(descriptor) }

            guard validLock(descriptor, at: lockURL) else {
                report.unsafe.append(name)
                continue
            }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                if errno == EWOULDBLOCK || errno == EAGAIN {
                    report.active.append(name)
                } else {
                    report.unsafe.append(name)
                }
                continue
            }
            defer { _ = flock(descriptor, LOCK_UN) }

            guard directory(candidate, ownsLock: descriptor, manager: manager),
                  hasOnlyDisposableContents(candidate, manager: manager) else {
                report.unsafe.append(name)
                continue
            }
            do {
                try manager.removeItem(at: candidate)
                report.removed.append(name)
            } catch {
                report.unsafe.append(name)
            }
        }

        report.removed.sort()
        report.active.sort()
        report.legacy.sort()
        report.unsafe.sort()
        return report
    }

    private static func isOwnedCandidateName(_ name: String) -> Bool {
        for prefix in [workPrefix, claimPrefix] where name.hasPrefix(prefix) {
            return UUID(uuidString: String(name.dropFirst(prefix.count))) != nil
        }
        return false
    }

    private static func isOwnedDirectory(_ url: URL) -> Bool {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == geteuid()
    }

    private static func validLock(_ descriptor: Int32, at url: URL) -> Bool {
        var descriptorInfo = stat()
        var pathInfo = stat()
        guard fstat(descriptor, &descriptorInfo) == 0,
              lstat(url.path, &pathInfo) == 0,
              (descriptorInfo.st_mode & S_IFMT) == S_IFREG,
              descriptorInfo.st_uid == geteuid(),
              descriptorInfo.st_dev == pathInfo.st_dev,
              descriptorInfo.st_ino == pathInfo.st_ino,
              descriptorInfo.st_size == lockMarker.count else {
            return false
        }
        var bytes = [UInt8](repeating: 0, count: lockMarker.count)
        let count = pread(descriptor, &bytes, bytes.count, 0)
        return count == bytes.count && Data(bytes) == lockMarker
    }

    private static func directory(
        _ directory: URL,
        ownsLock descriptor: Int32,
        manager: FileManager
    ) -> Bool {
        isOwnedDirectory(directory)
            && validLock(descriptor, at: directory.appendingPathComponent(lockName))
    }

    private static func hasOnlyDisposableContents(_ directory: URL, manager: FileManager) -> Bool {
        guard let contents = try? manager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: []
        ) else {
            return false
        }
        for item in contents {
            switch item.lastPathComponent {
            case lockName:
                continue
            case diskName:
                var info = stat()
                guard lstat(item.path, &info) == 0,
                      (info.st_mode & S_IFMT) == S_IFREG,
                      info.st_uid == geteuid() else {
                    return false
                }
            default:
                return false
            }
        }
        return true
    }

    private static func writeMarker(to descriptor: Int32) throws {
        guard ftruncate(descriptor, 0) == 0, lseek(descriptor, 0, SEEK_SET) == 0 else {
            throw HelperError.io("cannot initialize disposable VM ownership lock")
        }
        let wroteAll = lockMarker.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return lockMarker.isEmpty }
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), raw.count - offset)
                if count < 0, errno == EINTR { continue }
                if count <= 0 { return false }
                offset += count
            }
            return true
        }
        guard wroteAll, fsync(descriptor) == 0 else {
            throw HelperError.io("cannot persist disposable VM ownership lock")
        }
    }
}
