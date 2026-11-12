/// A Settings destination that an external entry point can open directly.
public enum SettingsScrollAnchor: Hashable, Sendable {
    case setting(SettingsIndex)
    case servers
    case providerQuotas
    case system

    /// The category the anchor opens; server updates live on the System page.
    public var category: SettingsCategory {
        switch self {
        case .setting(let entry): entry.category
        case .servers: .servers
        case .system: .system
        case .providerQuotas: .providers
        }
    }
}

extension SettingsScrollAnchor {
    public var pane: SettingsPane {
        if case .setting = self { .indexed(self) } else { .category(category) }
    }

    public var entry: SettingsIndex? {
        if case .setting(let entry) = self { entry } else { nil }
    }

    public var identifier: String? {
        if case .setting(let entry) = self { entry.id } else { nil }
    }
}
