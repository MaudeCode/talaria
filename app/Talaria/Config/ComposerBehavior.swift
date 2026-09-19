import Foundation

enum StreamingSendBehavior: String, CaseIterable, Identifiable {
    case steer
    case interrupt
    case queue

    static let storageKey = "streamingSendBehavior"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .steer:
            "Steer"
        case .interrupt:
            "Interrupt"
        case .queue:
            "Queue"
        }
    }

    var settingsDescription: String {
        switch self {
        case .steer:
            String(localized: "Steer active response")
        case .interrupt:
            String(localized: "Stop and send")
        case .queue:
            String(localized: "Send after response")
        }
    }

    static func storedValue(_ rawValue: String) -> StreamingSendBehavior {
        StreamingSendBehavior(rawValue: rawValue) ?? .steer
    }
}

enum ComposerSTTProviderPreference: String, CaseIterable, Identifiable {
    case serverFirst
    case onDeviceFirst
    case onDeviceOnly

    static let storageKey = "composerSTTProviderPreference"
    static let defaultValue: ComposerSTTProviderPreference = .serverFirst

    var id: String { rawValue }

    var title: String {
        switch self {
        case .serverFirst:
            String(localized: "Server first")
        case .onDeviceFirst:
            String(localized: "On-device first")
        case .onDeviceOnly:
            String(localized: "On-device only")
        }
    }

    static func storedValue(_ rawValue: String) -> ComposerSTTProviderPreference {
        ComposerSTTProviderPreference(rawValue: rawValue) ?? defaultValue
    }
}

enum ComposerSTTProvider: Equatable {
    case server
    case onDevice
}

enum ComposerSTTProviderPolicy {
    static func orderedProviders(
        preference: ComposerSTTProviderPreference,
        serverConfigured: Bool,
        onDeviceSupported: Bool
    ) -> [ComposerSTTProvider] {
        switch preference {
        case .serverFirst:
            return compactProviders(
                (.server, serverConfigured),
                (.onDevice, onDeviceSupported)
            )
        case .onDeviceFirst:
            return compactProviders(
                (.onDevice, onDeviceSupported),
                (.server, serverConfigured)
            )
        case .onDeviceOnly:
            return compactProviders((.onDevice, onDeviceSupported))
        }
    }

    static func fallbackProvider(
        after failedProvider: ComposerSTTProvider,
        preference: ComposerSTTProviderPreference,
        serverConfigured: Bool,
        onDeviceSupported: Bool
    ) -> ComposerSTTProvider? {
        let providers = orderedProviders(
            preference: preference,
            serverConfigured: serverConfigured,
            onDeviceSupported: onDeviceSupported
        )
        guard let failedIndex = providers.firstIndex(of: failedProvider) else {
            return nil
        }

        let fallbackIndex = providers.index(after: failedIndex)
        guard fallbackIndex < providers.endIndex else {
            return nil
        }
        return providers[fallbackIndex]
    }

    private static func compactProviders(
        _ candidates: (ComposerSTTProvider, Bool)...
    ) -> [ComposerSTTProvider] {
        candidates.compactMap { provider, isAvailable in
            isAvailable ? provider : nil
        }
    }
}
