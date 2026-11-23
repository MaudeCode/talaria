// Shared by the package tests and the App-hosted TalariaTests, which compiles this file too (TAL-399).
import Foundation
import XCTest

/// The one place a test opens a `UserDefaults` suite (TAL-2711). A suite named by a plain name keeps its plist in
/// `~/Library/Preferences`, and nothing a test does removes it for good: `removePersistentDomain(forName:)` leaves an
/// empty file, and cfprefsd writes a deleted file back seconds later with the writes it had not yet persisted. On macOS
/// each suite is therefore named by an absolute path inside this process's own temporary directory, so cfprefsd writes
/// its plist there, and the directory is deleted when the test bundle finishes. The App-hosted tests keep plain names:
/// their suites live in a disposable simulator container.
final class EphemeralDefaults: NSObject, XCTestObservation, @unchecked Sendable {
    /// Holds every suite's plist on macOS; other test processes have their own.
    static let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("talaria-defaults-\(UUID().uuidString)", isDirectory: true)
    private static let shared = EphemeralDefaults()
    private let lock = NSLock()
    private var observing = false

    /// A fresh, empty suite for `label`, with the name it was opened by.
    static func make(_ label: String) -> (suite: String, defaults: UserDefaults) {
        let name = "\(label).\(UUID().uuidString)"
        #if os(macOS)
        shared.observeOnce()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let suite = directory.appendingPathComponent(name).path
        #else
        let suite = name
        #endif
        return (suite, UserDefaults(suiteName: suite)!)
    }

    /// Deletes every suite file this process created. A write cfprefsd persists afterwards has no directory to land in.
    static func removeAll() {
        do {
            try FileManager.default.removeItem(at: directory)
        } catch CocoaError.fileNoSuchFile {
            // No suite was ever written.
        } catch {
            print("EphemeralDefaults: could not delete \(directory.path): \(error)")
        }
    }

    private func observeOnce() {
        let register = lock.withLock {
            defer { observing = true }
            return !observing
        }
        if register { XCTestObservationCenter.shared.addTestObserver(self) }
    }

    func testBundleDidFinish(_ testBundle: Bundle) {
        Self.removeAll()
    }
}

extension UserDefaults {
    /// A fresh, empty suite whose file is deleted when the test bundle finishes.
    static func ephemeral(_ label: String = "talaria") -> UserDefaults {
        EphemeralDefaults.make(label).defaults
    }
}
