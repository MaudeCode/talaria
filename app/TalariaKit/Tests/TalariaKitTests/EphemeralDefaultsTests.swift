import XCTest

final class EphemeralDefaultsTests: XCTestCase {
    func testASuitePlistStaysOutOfPreferencesAndRemoveAllDeletesIt() {
        let (suite, defaults) = EphemeralDefaults.make("EphemeralDefaultsTests")
        defaults.set("value", forKey: "key")
        defaults.synchronize()
        let preferences = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Preferences/\((suite as NSString).lastPathComponent).plist")
        let plist = suite + ".plist"
        XCTAssertFalse(FileManager.default.fileExists(atPath: preferences.path),
                       "The suite landed in \(preferences.path)")
        XCTAssertTrue(FileManager.default.fileExists(atPath: plist), "The write never reached \(plist)")

        EphemeralDefaults.removeAll()

        XCTAssertFalse(FileManager.default.fileExists(atPath: plist), "\(plist) was left behind")
    }
}
