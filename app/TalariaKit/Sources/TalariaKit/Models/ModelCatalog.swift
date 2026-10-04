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
    /// The server's split of `id` (`bare_id`); `nil` for an older server or a
    /// typed custom id.
    public let bareID: String?

    public init(id: String, displayName: String, providerID: String?, bareID: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.providerID = providerID
        self.bareID = bareID
    }
}

extension ModelCatalogOption {
    /// Whether this entry is the stored `(model, provider)` pair. The server
    /// splits every `@provider:model` id once and stamps each entry with its
    /// routing provider and bare id, so this is plain equality; a just-picked
    /// `id` names itself. An older server's unstamped entry matches its exact
    /// id, and a provider named on both sides still has to agree.
    public func matchesSelection(modelID: String?, providerID: String?) -> Bool {
        guard let modelID, !modelID.isEmpty else { return false }
        guard let bareID else {
            return id == modelID && (providerID == nil || self.providerID == nil || self.providerID == providerID)
        }
        return (bareID == modelID || id == modelID) && self.providerID == providerID
    }
}

extension Collection where Element == ModelCatalogOption {
    public func firstMatchingSelection(modelID: String?, providerID: String?) -> ModelCatalogOption? {
        first { $0.matchesSelection(modelID: modelID, providerID: providerID) }
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
                providerID: optionProviderID,
                bareID: stringValue(from: dict["bare_id"])
            )
        }
    }

    private static func stringValue(from value: JSONValue?) -> String? {
        guard case .string(let text) = value else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
