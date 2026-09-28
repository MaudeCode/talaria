import Foundation

public struct ModelsResponse: Decodable, Equatable {
    let groups: [JSONValue]?
    let models: [JSONValue]?
    public let defaultModel: String?
    public let activeProvider: String?
}

public struct CommandsResponse: Decodable, Equatable {
    public let commands: [AgentCommand]?
}

public struct AgentCommand: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { name ?? UUID().uuidString }

    public let name: String?
    public let description: String?
    let category: String?
    let aliases: [String]?
    public let argsHint: String?
    let subcommands: [String]?
    public let cliOnly: Bool?
    public let gatewayOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case name
        case description
        case category
        case aliases
        case argsHint
        case subcommands
        case cliOnly
        case gatewayOnly
    }

    init(
        name: String?,
        description: String? = nil,
        category: String? = nil,
        aliases: [String]? = nil,
        argsHint: String? = nil,
        subcommands: [String]? = nil,
        cliOnly: Bool? = nil,
        gatewayOnly: Bool? = nil
    ) {
        self.name = name
        self.description = description
        self.category = category
        self.aliases = aliases
        self.argsHint = argsHint
        self.subcommands = subcommands
        self.cliOnly = cliOnly
        self.gatewayOnly = gatewayOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        description = container.decodeLossyStringIfPresent(forKey: .description)
        category = container.decodeLossyStringIfPresent(forKey: .category)
        aliases = try? container.decodeIfPresent([String].self, forKey: .aliases)
        argsHint = container.decodeLossyStringIfPresent(forKey: .argsHint)
        subcommands = try? container.decodeIfPresent([String].self, forKey: .subcommands)
        cliOnly = container.decodeLossyBoolIfPresent(forKey: .cliOnly)
        gatewayOnly = container.decodeLossyBoolIfPresent(forKey: .gatewayOnly)
    }
}

/// `GET /api/providers` — read-only provider status (#26). Shape verified against
/// the live server (2026-07-02) and upstream `api/providers.py::get_providers()`
/// @ `312d3fab`: standard entries carry the full field set, while entries derived
/// from `custom_providers` in config.yaml (`is_custom == true`) omit `is_oauth`,
/// `auth_error`, `is_self_hosted`, `base_url`, and `is_plugin_provider` — so every
/// field stays optional and decoding never fails on a partial entry.
public struct ProvidersResponse: Decodable, Equatable {
    public let providers: [ProviderSummary]?
    public let activeProvider: String?

    init(providers: [ProviderSummary]?, activeProvider: String?) {
        self.providers = providers
        self.activeProvider = activeProvider
    }

    enum CodingKeys: String, CodingKey {
        case providers
        case activeProvider
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providers = try? container.decodeIfPresent([ProviderSummary].self, forKey: .providers)
        activeProvider = container.decodeLossyStringIfPresent(forKey: .activeProvider)
    }
}


/// One provider entry from `GET /api/providers`. `keySource` vocabulary upstream:
/// `env_file`, `env_var`, `config_yaml`, `oauth`, `none` — plus `env`, `config`,
/// and `token` from the live-auth fallback probe. Unknown values are kept verbatim.
public struct ProviderSummary: Decodable, Equatable, Sendable {
    public let id: String?
    public let displayName: String?
    public let hasKey: Bool?
    let configurable: Bool?
    let isSelfHosted: Bool?
    let baseUrl: String?
    let isPluginProvider: Bool?
    let isOauth: Bool?
    let isCustom: Bool?
    public let keySource: String?
    public let authError: String?
    public let models: [ProviderModel]?
    /// Size of the provider's complete catalog. May exceed `models.count` when the
    /// server trims the list to a featured subset (e.g. large Nous Portal accounts).
    public let modelsTotal: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName
        case hasKey
        case configurable
        case isSelfHosted
        case baseUrl
        case isPluginProvider
        case isOauth
        case isCustom
        case keySource
        case authError
        case models
        case modelsTotal
    }

    init(
        id: String?,
        displayName: String? = nil,
        hasKey: Bool? = nil,
        configurable: Bool? = nil,
        isSelfHosted: Bool? = nil,
        baseUrl: String? = nil,
        isPluginProvider: Bool? = nil,
        isOauth: Bool? = nil,
        isCustom: Bool? = nil,
        keySource: String? = nil,
        authError: String? = nil,
        models: [ProviderModel]? = nil,
        modelsTotal: Int? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.hasKey = hasKey
        self.configurable = configurable
        self.isSelfHosted = isSelfHosted
        self.baseUrl = baseUrl
        self.isPluginProvider = isPluginProvider
        self.isOauth = isOauth
        self.isCustom = isCustom
        self.keySource = keySource
        self.authError = authError
        self.models = models
        self.modelsTotal = modelsTotal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.decodeLossyStringIfPresent(forKey: .id)
        displayName = container.decodeLossyStringIfPresent(forKey: .displayName)
        hasKey = container.decodeLossyBoolIfPresent(forKey: .hasKey)
        configurable = container.decodeLossyBoolIfPresent(forKey: .configurable)
        isSelfHosted = container.decodeLossyBoolIfPresent(forKey: .isSelfHosted)
        baseUrl = container.decodeLossyStringIfPresent(forKey: .baseUrl)
        isPluginProvider = container.decodeLossyBoolIfPresent(forKey: .isPluginProvider)
        isOauth = container.decodeLossyBoolIfPresent(forKey: .isOauth)
        isCustom = container.decodeLossyBoolIfPresent(forKey: .isCustom)
        keySource = container.decodeLossyStringIfPresent(forKey: .keySource)
        authError = container.decodeLossyStringIfPresent(forKey: .authError)
        models = try? container.decodeIfPresent([ProviderModel].self, forKey: .models)
        modelsTotal = container.decodeLossyIntIfPresent(forKey: .modelsTotal)
    }
}

/// A model entry inside a provider's `models` list. Upstream normally emits
/// `{ "id": …, "label": … }` objects, but the docs historically described bare
/// model-ID strings — both shapes decode.
public struct ProviderModel: Decodable, Equatable, Sendable {
    public let id: String?
    public let label: String?

    init(id: String?, label: String? = nil) {
        self.id = id
        self.label = label
    }

    enum CodingKeys: String, CodingKey {
        case id
        case label
    }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
           let raw = try? single.decode(String.self) {
            id = raw
            label = raw
            return
        }

        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.decodeLossyStringIfPresent(forKey: .id)
        label = container.decodeLossyStringIfPresent(forKey: .label)
    }
}

/// `GET /api/settings` (the saved-settings body `POST /api/settings` echoes the
/// same shape back). The server returns ~75 keys; we decode only the ones with
/// a consumer or near-term use (#19). Every field is optional and lossy-decoded
/// — servers omit keys freely and we never crash on an unexpected shape.
