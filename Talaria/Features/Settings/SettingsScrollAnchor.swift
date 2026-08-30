/// A Settings destination that an external entry point can open directly.
enum SettingsScrollAnchor: Hashable {
    case servers
    case providerQuotas

    var category: SettingsCategory {
        switch self {
        case .servers: .serversAndProviders
        case .providerQuotas: .providerQuotas
        }
    }
}
