import XCTest
@testable import TalariaKit

final class AppIconChoiceTests: XCTestCase {
    func testResolvedMapsAlternateIconNames() {
        XCTAssertEqual(AppIconChoice.resolved(from: nil), .system)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.lightAlternateIconName), .light)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.darkAlternateIconName), .dark)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.discoAlternateIconName), .disco)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.monochromeLightAlternateIconName), .monochromeLight)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.monochromeDarkAlternateIconName), .monochromeDark)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.gradientLightAlternateIconName), .gradientLight)
        XCTAssertEqual(AppIconChoice.resolved(from: AppIconChoice.gradientDarkAlternateIconName), .gradientDark)
        XCTAssertEqual(AppIconChoice.resolved(from: "UnknownIcon"), .system)
    }

    func testEveryChoiceRoundTripsThroughItsAlternateIconName() {
        for icon in AppIconChoice.allCases {
            XCTAssertEqual(AppIconChoice.resolved(from: icon.alternateIconName), icon)
        }
    }

    func testPreviewImageNameMapping() {
        XCTAssertNil(AppIconChoice.system.previewImageName)
        XCTAssertEqual(AppIconChoice.light.previewImageName, "AppIconLightPreview")
        XCTAssertEqual(AppIconChoice.dark.previewImageName, "AppIconDarkPreview")
        XCTAssertEqual(AppIconChoice.disco.previewImageName, "AppIconDiscoPreview")
        XCTAssertEqual(AppIconChoice.monochromeLight.previewImageName, "AppIconMonochromeLightPreview")
        XCTAssertEqual(AppIconChoice.monochromeDark.previewImageName, "AppIconMonochromeDarkPreview")
        XCTAssertEqual(AppIconChoice.gradientLight.previewImageName, "AppIconGradientLightPreview")
        XCTAssertEqual(AppIconChoice.gradientDark.previewImageName, "AppIconGradientDarkPreview")
    }

    func testAllCasesUseApprovedDisplayOrder() {
        XCTAssertEqual(
            AppIconChoice.allCases,
            [.system, .light, .dark, .disco, .monochromeLight, .monochromeDark, .gradientLight, .gradientDark]
        )
    }

    func testChoiceDisplayTitles() {
        XCTAssertEqual(
            AppIconChoice.allCases.map(\.title),
            [
                "System", "Light", "Dark", "Disco",
                "Monochrome Light", "Monochrome Dark", "Gradient Light", "Gradient Dark",
            ]
        )
    }
}
