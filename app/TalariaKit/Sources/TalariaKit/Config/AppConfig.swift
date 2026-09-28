import Foundation
import OSLog

public enum AppConfig {
    public static let privacyPolicyURL = URL(string: "https://talaria.kil.dev/privacy")!
    public static let supportURL = URL(string: "https://talaria.kil.dev")!

    static let clientIdentityHeaderName = "X-Talaria-Client"
    static let clientIdentity = (try? releaseIdentity(info: Bundle.main.infoDictionary ?? [:])) ?? "{}"

    /// Public build metadata only: never include server URLs, credentials or device IDs.
    static func releaseIdentity(info: [String: Any]) throws -> String {
        let version = info["CFBundleShortVersionString"] as? String ?? "development"
        let build = info["CFBundleVersion"] as? String ?? "development"
        let release = info["TalariaRelease"] as? [String: Any] ?? [:]
        let capabilities = release["contracts"] as? [String: Any] ?? [:]
        let source = release["sourceRevision"] as? String ?? ""
        let isStamped = source.count == 40
            && source.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil
            && release["releaseSet"] as? String == source
            && release["version"] as? String == version
            && (release["buildNumber"] as? NSNumber)?.stringValue == build
        let identity: [String: Any] = [
            "version": version,
            "buildNumber": build,
            "sourceRevision": isStamped ? source as Any : NSNull(),
            "releaseSet": isStamped ? source as Any : NSNull(),
            "contracts": [
                "appWeb": capabilities["appWeb"] as? [Int] ?? [],
                "appRelay": capabilities["appRelay"] as? [Int] ?? [],
                "activityScene": capabilities["activityScene"] as? [String] ?? []
            ]
        ]
        return String(decoding: try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]), as: UTF8.self)
    }

    public static func applyClientIdentity(to request: inout URLRequest) {
        request.setValue(clientIdentity, forHTTPHeaderField: clientIdentityHeaderName)
    }

    public static func logReleaseIdentity() {
        Logger(subsystem: "dev.kil.talaria", category: "release")
            .notice("Release identity: \(clientIdentity, privacy: .public)")
    }
}
