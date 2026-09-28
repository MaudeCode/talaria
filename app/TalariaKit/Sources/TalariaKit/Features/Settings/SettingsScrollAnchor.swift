/// A Settings destination that an external entry point can open directly.
public enum SettingsScrollAnchor: Hashable {
    case servers
    case providerQuotas
    case system

    public var destination: SettingsDestination {
        switch self {
        case .servers: .servers
        case .providerQuotas: .providerQuotas
        case .system: .servers
        }
    }
}
