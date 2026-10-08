import Foundation

public enum StreamingSendBehavior: String, CaseIterable, Identifiable {
    case steer
    case interrupt
    case queue

    public static let storageKey = "streamingSendBehavior"

    public var id: String { rawValue }

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

    public var settingsDescription: String {
        switch self {
        case .steer:
            String(localized: "Steer active response")
        case .interrupt:
            String(localized: "Stop and send")
        case .queue:
            String(localized: "Send after response")
        }
    }

    /// The other way to send while a reply runs, for Ctrl+Return: queue when the setting sends now, steer when it queues.
    public var alternate: StreamingSendBehavior {
        self == .queue ? .steer : .queue
    }

    public static func storedValue(_ rawValue: String) -> StreamingSendBehavior {
        StreamingSendBehavior(rawValue: rawValue) ?? .steer
    }
}

/// The hardware-keyboard key that sends the draft; the other of Return and ⌘Return inserts a newline.
public enum ComposerSendKey: String, CaseIterable, Identifiable {
    case `return`
    case commandReturn

    public static let storageKey = "composerSendKey"
    public static let defaultValue: ComposerSendKey = .return

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .return:
            String(localized: "Return")
        case .commandReturn:
            String(localized: "⌘ Return")
        }
    }

    public static func storedValue(_ rawValue: String) -> ComposerSendKey {
        ComposerSendKey(rawValue: rawValue) ?? defaultValue
    }
}

public enum ComposerSTTProviderPreference: String, CaseIterable, Identifiable {
    case serverFirst
    case onDeviceFirst
    case onDeviceOnly

    public static let storageKey = "composerSTTProviderPreference"
    public static let defaultValue: ComposerSTTProviderPreference = .serverFirst

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .serverFirst:
            String(localized: "Server first")
        case .onDeviceFirst:
            String(localized: "On-device first")
        case .onDeviceOnly:
            String(localized: "On-device only")
        }
    }

    public static func storedValue(_ rawValue: String) -> ComposerSTTProviderPreference {
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
