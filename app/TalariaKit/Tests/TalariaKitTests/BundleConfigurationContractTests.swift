import Foundation
import XCTest
@testable import TalariaKit

final class BundleConfigurationContractTests: XCTestCase {
    private var repositoryRoot: URL {
        // app/TalariaKit/Tests/TalariaKitTests/<file> -> app
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    func testAppDeclaresRequiredPrivacyUsageDescriptionsAndURLScheme() throws {
        let info = try propertyList("Talaria/Resources/Info.plist")
        let requiredDescriptions = [
            "NSCameraUsageDescription",
            "NSPhotoLibraryUsageDescription",
            "NSPhotoLibraryAddUsageDescription",
            "NSMicrophoneUsageDescription",
            "NSSpeechRecognitionUsageDescription"
        ]

        for key in requiredDescriptions {
            let value = try XCTUnwrap(info[key] as? String, "Missing \(key) in Talaria Info.plist")
            XCTAssertFalse(
                value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                "\(key) must explain why Talaria needs access"
            )
        }

        XCTAssertEqual(info["NSSupportsLiveActivities"] as? Bool, true, "Live Activities must remain enabled")
        XCTAssertEqual(info["TalariaURLScheme"] as? String, "$(TALARIA_URL_SCHEME)")
        let urlTypes = try XCTUnwrap(info["CFBundleURLTypes"] as? [[String: Any]], "Missing CFBundleURLTypes")
        let schemes = urlTypes.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["$(TALARIA_URL_SCHEME)"], "Talaria URL scheme is missing or duplicated")

        for (name, path) in [
            ("share extension", "TalariaShareExtension/Resources/Info.plist"),
            ("Live Activity widget", "TalariaLiveActivityWidget/Resources/Info.plist")
        ] {
            let bundleInfo = try propertyList(path)
            XCTAssertEqual(
                bundleInfo["TalariaURLScheme"] as? String,
                info["TalariaURLScheme"] as? String,
                "\(name) has a mismatched TalariaURLScheme"
            )
        }

        let project = try projectFile()
        assertOccurrences(of: "TALARIA_URL_SCHEME = \"talaria$(APP_URL_SCHEME_SUFFIX)\";", count: 2, in: project)
    }

    func testAppGroupIdentifiersStayAlignedAcrossBundles() throws {
        let expected = ["$(APP_GROUP_IDENTIFIER)"]
        let bundlePaths = [
            ("Talaria", "Talaria/Resources/Info.plist", "Talaria/Resources/Talaria.entitlements"),
            (
                "share extension",
                "TalariaShareExtension/Resources/Info.plist",
                "TalariaShareExtension/Resources/TalariaShareExtension.entitlements"
            ),
            (
                "Live Activity widget",
                "TalariaLiveActivityWidget/Resources/Info.plist",
                "TalariaLiveActivityWidget/Resources/TalariaLiveActivityWidget.entitlements"
            )
        ]

        for (name, infoPath, entitlementPath) in bundlePaths {
            let info = try propertyList(infoPath)
            let entitlements = try propertyList(entitlementPath)
            XCTAssertEqual(
                info["TalariaAppGroupIdentifier"] as? String,
                expected[0],
                "\(name) Info.plist has a mismatched TalariaAppGroupIdentifier"
            )
            XCTAssertEqual(
                entitlements["com.apple.security.application-groups"] as? [String],
                expected,
                "\(name) entitlements have a mismatched app group"
            )
        }

        let project = try projectFile()
        let sharedSettings = try sourceFile("Config/Shared.xcconfig")
        assertOccurrences(
            of: "APP_GROUP_IDENTIFIER = group.dev.kil.talaria$(APP_IDENTIFIER_SUFFIX)",
            count: 1,
            in: sharedSettings
        )
        assertOccurrences(of: "Shared.xcconfig */;", count: 2, in: project)
        assertOccurrences(of: "APP_GROUP_IDENTIFIER =", count: 0, in: project)
        assertOccurrences(of: "APP_IDENTIFIER_SUFFIX =", count: 0, in: project)
    }

    func testAppMaySendTimeSensitiveNotifications() throws {
        let entitlements = try propertyList("Talaria/Resources/Talaria.entitlements")
        XCTAssertEqual(
            entitlements["com.apple.developer.usernotifications.time-sensitive"] as? Bool,
            true,
            "The Time Sensitive quota alert setting needs this entitlement to break through Focus"
        )
    }

    func testPrivacyManifestsAndExtensionsRemainInBuildProducts() throws {
        let appManifest = try propertyList("Talaria/Resources/PrivacyInfo.xcprivacy")
        XCTAssertEqual(appManifest["NSPrivacyTracking"] as? Bool, false, "App privacy manifest must disable tracking")
        XCTAssertEqual(appManifest["NSPrivacyCollectedDataTypes"] as? [AnyHashable], [], "App declares collected data")
        XCTAssertEqual(appManifest["NSPrivacyTrackingDomains"] as? [String], [], "App declares tracking domains")

        let accessedAPIs = try XCTUnwrap(
            appManifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]],
            "App privacy manifest is missing NSPrivacyAccessedAPITypes"
        )
        let userDefaults = try XCTUnwrap(
            accessedAPIs.first { $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults" },
            "App privacy manifest is missing its UserDefaults declaration"
        )
        XCTAssertEqual(
            Set(userDefaults["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? []),
            Set(["CA92.1", "1C8F.1"]),
            "App privacy manifest has mismatched UserDefaults reasons"
        )

        let shareManifest = try propertyList("TalariaShareExtension/Resources/PrivacyInfo.xcprivacy")
        XCTAssertEqual(shareManifest["NSPrivacyTracking"] as? Bool, false, "Share extension privacy manifest must disable tracking")
        XCTAssertEqual(shareManifest["NSPrivacyCollectedDataTypes"] as? [AnyHashable], [], "Share extension declares collected data")
        XCTAssertEqual(shareManifest["NSPrivacyAccessedAPITypes"] as? [AnyHashable], [], "Share extension declares accessed APIs")

        let project = try projectFile()
        let privacyResources = [
            ("app", "1A2B3C4D5E6F700000000060", "1A2B3C4D5E6F70000000300", "1A2B3C4D5E6F70000000301"),
            ("share extension", "B5A100000000000000000022", "B5A100000000000000000004", "B5A100000000000000000014"),
            ("Live Activity widget", "A04500000000000000000060", "A0610000000000000000000B", "1A2B3C4D5E6F70000000301")
        ]
        for (name, phaseID, buildFileID, fileReferenceID) in privacyResources {
            let buildFileMapping = """
            \(buildFileID) /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = \(fileReferenceID) /* PrivacyInfo.xcprivacy */; };
            """
            XCTAssertTrue(
                project.contains(buildFileMapping),
                "\(name) privacy manifest build-file mapping is missing or mismatched"
            )
            let phaseStart = try XCTUnwrap(
                project.range(of: "\(phaseID) /* Resources */ = {"),
                "\(name) resource phase is missing"
            )
            let phaseRemainder = project[phaseStart.lowerBound...]
            let phaseEnd = try XCTUnwrap(
                phaseRemainder.range(of: "\n\t\t};"),
                "\(name) resource phase is malformed"
            )
            XCTAssertTrue(
                phaseRemainder[..<phaseEnd.upperBound].contains(
                    "\(buildFileID) /* PrivacyInfo.xcprivacy in Resources */"
                ),
                "\(name) does not embed its required privacy manifest"
            )
        }
        assertOccurrences(of: "TalariaShareExtension.appex in Embed App Extensions", count: 2, in: project)
        assertOccurrences(of: "TalariaLiveActivityWidget.appex in Embed App Extensions", count: 2, in: project)

        let settings = [
            "INFOPLIST_FILE = Talaria/Resources/Info.plist;",
            "CODE_SIGN_ENTITLEMENTS = Talaria/Resources/Talaria.entitlements;",
            "INFOPLIST_FILE = TalariaShareExtension/Resources/Info.plist;",
            "CODE_SIGN_ENTITLEMENTS = TalariaShareExtension/Resources/TalariaShareExtension.entitlements;",
            "PRODUCT_BUNDLE_IDENTIFIER = \"$(APP_BUNDLE_IDENTIFIER).shareextension\";",
            "INFOPLIST_FILE = TalariaLiveActivityWidget/Resources/Info.plist;",
            "CODE_SIGN_ENTITLEMENTS = TalariaLiveActivityWidget/Resources/TalariaLiveActivityWidget.entitlements;",
            "PRODUCT_BUNDLE_IDENTIFIER = \"$(APP_BUNDLE_IDENTIFIER).liveactivitywidget\";"
        ]
        for setting in settings {
            assertOccurrences(of: setting, count: 2, in: project)
        }
    }

    func testEverySelectableAppIconHasDeclaredAssets() throws {
        let expectedAlternateNames = Set(AppIconChoice.allCases.compactMap(\.alternateIconName))
        let project = try projectFile()
        let settingLines = project.components(separatedBy: .newlines).filter {
            $0.contains("ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES =")
        }
        XCTAssertEqual(settingLines.count, 2, "Debug and Release must both declare alternate app icons")

        for line in settingLines {
            let value = line.split(separator: "=", maxSplits: 1)[1]
                .trimmingCharacters(in: CharacterSet(charactersIn: " \t;\""))
            XCTAssertEqual(Set(value.split(separator: " ").map(String.init)), expectedAlternateNames)
        }

        for icon in AppIconChoice.allCases {
            XCTAssertEqual(
                icon.alternateIconName == nil,
                icon.previewImageName == nil,
                "\(icon.rawValue) must declare both an alternate icon and preview, or neither"
            )
            guard let alternateName = icon.alternateIconName,
                  let previewName = icon.previewImageName else { continue }
            try assertAsset(named: alternateName, kind: "appiconset")
            try assertAsset(named: previewName, kind: "imageset")
        }
    }

    /// TAL-330: Talaria Dev installs beside the App Store/TestFlight app with its own IDs, name and DEV-banner icon.
    func testDevConfigurationSwapsIdentityNameAndIcon() throws {
        let shared = try sourceFile("Config/Shared.xcconfig")
        let dev = try sourceFile("Config/Dev.xcconfig")
        let project = try projectFile()
        assertOccurrences(of: "APP_ICON_NAME = Talaria\n", count: 1, in: shared)
        assertOccurrences(of: "ASSETCATALOG_COMPILER_APPICON_NAME = \"$(APP_ICON_NAME)\";", count: 2, in: project)
        for setting in [
            "APP_IDENTIFIER_SUFFIX = .branch\n",
            "APP_DISPLAY_NAME = Talaria Dev\n",
            "APP_URL_SCHEME_SUFFIX = -branch\n",
            "APP_ICON_NAME = TalariaDev\n",
            "ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES =\n"
        ] {
            assertOccurrences(of: setting, count: 1, in: dev)
        }
        for icon in ["Talaria", "TalariaDev"] {
            assertOccurrences(of: "/* \(icon).icon in Resources */,", count: 1, in: project)
            let document = repositoryRoot.appendingPathComponent("Talaria/Resources/\(icon).icon/icon.json")
            XCTAssertTrue(FileManager.default.fileExists(atPath: document.path), "\(icon).icon is missing")
        }
    }

    private func propertyList(_ relativePath: String) throws -> [String: Any] {
        let url = repositoryRoot.appendingPathComponent(relativePath)
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
            "Could not parse property list at \(relativePath)"
        )
    }

    private func projectFile() throws -> String {
        try sourceFile("Talaria.xcodeproj/project.pbxproj")
    }

    private func sourceFile(_ relativePath: String) throws -> String {
        try String(contentsOf: repositoryRoot.appendingPathComponent(relativePath), encoding: .utf8)
    }

    private func assertOccurrences(
        of value: String,
        count: Int,
        in text: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(
            text.components(separatedBy: value).count - 1,
            count,
            "Expected \(count) project entries for: \(value)",
            file: file,
            line: line
        )
    }

    private func assertAsset(named name: String, kind: String) throws {
        let directory = repositoryRoot
            .appendingPathComponent("Talaria/Resources/Assets.xcassets")
            .appendingPathComponent("\(name).\(kind)")
        let contentsURL = directory.appendingPathComponent("Contents.json")
        let data = try Data(contentsOf: contentsURL)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any],
            "Could not parse \(name).\(kind)/Contents.json"
        )
        let images = try XCTUnwrap(json["images"] as? [[String: Any]], "\(name).\(kind) has no images array")
        let filenames = images.compactMap { $0["filename"] as? String }
        XCTAssertFalse(filenames.isEmpty, "\(name).\(kind) does not declare an image file")
        for filename in filenames {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: directory.appendingPathComponent(filename).path),
                "\(name).\(kind) references missing file \(filename)"
            )
        }
    }
}
