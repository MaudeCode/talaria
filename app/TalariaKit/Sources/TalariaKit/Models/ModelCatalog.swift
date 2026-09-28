import Foundation

public struct ModelCatalogGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let providerID: String?
    public let models: [ModelCatalogOption]
    public let extraModels: [ModelCatalogOption]

    public init(
        id: String,
        name: String,
        providerID: String?,
        models: [ModelCatalogOption],
        extraModels: [ModelCatalogOption]
    ) {
        self.id = id
        self.name = name
        self.providerID = providerID
        self.models = models
        self.extraModels = extraModels
    }

    public init(
        id: String,
        name: String,
        providerID: String?,
        models: [ModelCatalogOption]
    ) {
        self.init(
            id: id,
            name: name,
            providerID: providerID,
            models: models,
            extraModels: []
        )
    }
}

extension ModelCatalogGroup {
    public var slashAutocompleteModels: [ModelCatalogOption] {
        var seen = Set<String>()
        return (models + extraModels).filter { seen.insert($0.id).inserted }
    }
}

public struct ModelCatalogOption: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let providerID: String?

    public init(id: String, displayName: String, providerID: String?) {
        self.id = id
        self.displayName = displayName
        self.providerID = providerID
    }
}

public struct ProviderQualifiedModelID: Equatable, Hashable, Sendable {
    let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    /// The model id without the `@provider:` prefix the server adds to models
    /// that belong to a provider other than the active one
    /// (`_apply_provider_prefix`, `api/config.py:2279` @ 399cd7ab — verified on
    /// the live deployment, where `openai-codex` is active and its models are
    /// bare while `@deepseek:` and `@gemini:` ones are prefixed).
    ///
    /// The same model is therefore spelled differently depending on which
    /// provider happens to be active, so a saved default written under one
    /// spelling stopped matching the catalog under the other and the picker
    /// showed no checkmark at all.
    var bareValue: String {
        guard rawValue.hasPrefix("@"), let separator = rawValue.lastIndex(of: ":") else {
            return rawValue
        }
        return String(rawValue[rawValue.index(after: separator)...])
    }

    /// The provider named by an `@provider:` prefix, if there is one. The
    /// provider may itself contain colons, so the final separator begins the
    /// model id.
    public var providerPrefix: String? {
        guard rawValue.hasPrefix("@"), let separator = rawValue.lastIndex(of: ":") else { return nil }
        let provider = rawValue[rawValue.index(after: rawValue.startIndex)..<separator]
        return provider.isEmpty ? nil : String(provider)
    }

    func normalized(for providerID: String?) -> String {
        guard let providerID else { return bareValue }
        let prefix = "@\(providerID):"
        guard rawValue.hasPrefix(prefix) else { return bareValue }
        return String(rawValue.dropFirst(prefix.count))
    }
}

extension ModelCatalogOption {
    public func matchesSelection(modelID: String?, providerID: String?) -> Bool {
        guard let modelID else { return false }

        let optionID = ProviderQualifiedModelID(id)
        let selectionID = ProviderQualifiedModelID(modelID)
        let optionProvider = self.providerID ?? optionID.providerPrefix
        let selectionProvider = providerID
            ?? optionProvider.flatMap { selectionID.rawValue.hasPrefix("@\($0):") ? $0 : nil }
            ?? selectionID.providerPrefix
        guard optionID.normalized(for: optionProvider) == selectionID.normalized(for: selectionProvider)
        else { return false }

        // A provider named on either side has to agree, so two providers
        // offering the same bare id can't be confused — this deployment really
        // does serve `@gemini:gemini-2.5-flash` and `@google:gemini-2.5-flash`
        // side by side. The `@provider:` prefix counts as naming one.
        guard let selectionProvider else {
            // A selection that names no provider is the active provider's
            // spelling, because the prefix is exactly what the server adds to
            // everyone else. Matching it against a prefixed option would tick
            // every provider that happens to offer the same bare id.
            return optionID.providerPrefix == nil
        }
        // Same rule in the other direction. An option carrying no provider at
        // all cannot be shown to belong to the named one, and guessing "yes"
        // here is the exact mirror of the double-checkmark bug the selection
        // side above was just fixed for. This also restores what the original
        // `self.providerID == providerID` comparison did before the prefix
        // normalization was added, so it is not a new restriction.
        //
        // `parseModelOptions` fills `providerID` from the group's `provider_id`,
        // so this is only reachable if a server returns a group without one.
        guard let optionProvider else { return false }
        return optionProvider == selectionProvider
    }
}

extension Collection where Element == ModelCatalogOption {
    public func firstMatchingSelection(modelID: String?, providerID: String?) -> ModelCatalogOption? {
        guard let modelID, !modelID.isEmpty else { return nil }

        // Prefer the identical spelling; only then fall back to the normalized
        // comparison, so an exact match is never lost to a same-named model.
        if let exact = first(where: { $0.id == modelID && (providerID == nil || $0.providerID == providerID) }) {
            return exact
        }

        return first { $0.matchesSelection(modelID: modelID, providerID: providerID) }
    }
}

extension ModelsResponse {
    public var catalogGroups: [ModelCatalogGroup] {
        ModelCatalogParser.parseGroups(from: self)
    }

    func displayName(for modelID: String?) -> String? {
        guard let modelID else { return nil }
        return catalogGroups
            .flatMap(\.slashAutocompleteModels)
            .first(where: { $0.id == modelID })?
            .displayName
    }
}

/// Response of `GET /api/models/live`: the uncached model list for one provider.
/// Shape: `{"provider": "<id>", "models": [{"id", "label"}], "count": <int>}`;
/// the server echoes back the provider it resolved when none was requested.
public struct ModelsLiveResponse: Decodable, Equatable {
    let provider: String?
    let models: [JSONValue]?
    let count: Int?
}

extension ModelsLiveResponse {
    /// Provider id with whitespace-only values normalized away.
    var normalizedProvider: String? {
        let trimmed = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    /// Models parsed from the live payload, attributed to the echoed provider.
    var liveOptions: [ModelCatalogOption] {
        guard let models else { return [] }
        return ModelCatalogParser.parseModelOptions(
            from: .array(models),
            providerID: normalizedProvider
        )
    }
}

extension Array where Element == ModelCatalogGroup {
    /// Replaces the matching provider group's models with the live list (live is
    /// authoritative for that provider, covering both additions and removals).
    /// Returns `self` unchanged when the provider matches no group or the live
    /// list is empty, so an odd live response can never blank out the cached picker.
    public func mergingLiveModels(from response: ModelsLiveResponse) -> [ModelCatalogGroup] {
        guard let provider = response.normalizedProvider else { return self }

        let liveModels = response.liveOptions
        guard !liveModels.isEmpty else { return self }

        return map { group in
            guard group.providerID == provider else { return group }
            return ModelCatalogGroup(
                id: group.id,
                name: group.name,
                providerID: group.providerID,
                models: liveModels,
                extraModels: group.extraModels
            )
        }
    }
}

private enum ModelCatalogParser {
    static func parseGroups(from response: ModelsResponse) -> [ModelCatalogGroup] {
        guard let groupValues = response.groups else { return [] }

        return groupValues.enumerated().compactMap { index, groupValue in
            guard case .object(let groupDict) = groupValue else { return nil }

            let providerID = stringValue(from: groupDict["provider_id"])
            let name = stringValue(from: groupDict["name"]) ?? providerID ?? String(localized: "Models")
            let models = parseModelOptions(from: groupDict["models"], providerID: providerID)
            let extraModels = parseModelOptions(from: groupDict["extra_models"], providerID: providerID)
            guard !models.isEmpty else { return nil }

            return ModelCatalogGroup(
                id: providerID ?? "\(name)-\(index)",
                name: name,
                providerID: providerID,
                models: models,
                extraModels: extraModels
            )
        }
    }

    static func parseModelOptions(from value: JSONValue?, providerID: String?) -> [ModelCatalogOption] {
        guard case .array(let items) = value else { return [] }

        return items.compactMap { item in
            guard case .object(let dict) = item else { return nil }

            let id = stringValue(from: dict["id"]) ?? ""
            guard !id.isEmpty else { return nil }

            let displayName = stringValue(from: dict["name"])
                ?? stringValue(from: dict["label"])
                ?? id
            let optionProviderID = stringValue(from: dict["provider_id"]) ?? providerID

            return ModelCatalogOption(
                id: id,
                displayName: displayName,
                providerID: optionProviderID
            )
        }
    }

    private static func stringValue(from value: JSONValue?) -> String? {
        guard case .string(let text) = value else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
