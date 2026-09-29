import UIKit
import XCTest
@testable import TalariaKit

/// Every alternate icon the Appearance picker offers ships in the built app under the name the
/// picker passes to `setAlternateIconName`. The asset catalog compiler writes an alternate into
/// `CFBundleAlternateIcons` only after compiling its icon set, and fails the build for a listed
/// set it cannot find. `AppIconSwitchingUITests` applies one alternate through the picker
/// and the system; applying every alternate that way cost minutes of system
/// alerts, and a hosted test cannot dismiss the alert each change raises (TAL-402).
final class AppIconAlternateTests: XCTestCase {
    func testEveryPickerAlternateIsDeclaredInTheBuiltApp() throws {
        let icons = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any])
        let alternates = try XCTUnwrap(icons["CFBundleAlternateIcons"] as? [String: [String: Any]])
        let names = AppIconChoice.allCases.compactMap(\.alternateIconName)
        XCTAssertEqual(names.count, AppIconChoice.allCases.count - 1, "Only System uses the primary icon")
        XCTAssertEqual(Set(alternates.keys), Set(names), "The declared alternates and the picker's choices differ")
        for name in names {
            XCTAssertEqual(alternates[name]?["CFBundleIconName"] as? String, name, "\(name) is not declared")
        }
    }
}
