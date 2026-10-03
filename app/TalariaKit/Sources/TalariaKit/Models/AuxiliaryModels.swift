public import Foundation

/// `GET /api/model/auxiliary` (TAL-388): the active profile's auxiliary task
/// slots in server order. The server owns ordering, catalog matching, and every
/// display value; the app renders these fields.
public struct AuxiliaryModelsResponse: Decodable, Equatable, Sendable {
    public let tasks: [AuxiliaryModelTask]

    /// False for a server that predates the typed slot fields: the app shows
    /// an unavailable state instead of deriving them.
    public var isSupported: Bool {
        !tasks.isEmpty && tasks.allSatisfy { $0.isAuto != nil && $0.inCatalog != nil }
    }

    private enum CodingKeys: String, CodingKey {
        case tasks
    }

    public init(tasks: [AuxiliaryModelTask]) {
        self.tasks = tasks
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = container.decodeLossyArrayIfPresent(AuxiliaryModelTask.self, forKey: .tasks) ?? []
    }
}

public struct AuxiliaryModelTask: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { task }

    public let task: String
    public let label: String
    public let description: String
    /// Saved provider (`auto` when unset) and bare model, sent back unchanged
    /// to keep an off-catalog model.
    public let provider: String
    public let model: String
    /// No override is saved: the task uses the main chat model.
    public let isAuto: Bool?
    /// The model the task uses (the main model when Auto) and its provider name.
    public let valueLabel: String?
    public let providerLabel: String?
    /// The `/api/models` entry id the server matched to the saved pair.
    public let selectedOptionID: String?
    /// False only for a pinned model the current catalog does not list.
    public let inCatalog: Bool?

    private enum CodingKeys: String, CodingKey {
        case task
        case label
        case description
        case provider
        case model
        case isAuto
        case valueLabel
        case providerLabel
        case selectedOptionID = "selectedOptionId"
        case inCatalog
    }

    public init(
        task: String,
        label: String,
        description: String,
        provider: String,
        model: String,
        isAuto: Bool?,
        valueLabel: String?,
        providerLabel: String?,
        selectedOptionID: String?,
        inCatalog: Bool?
    ) {
        self.task = task
        self.label = label
        self.description = description
        self.provider = provider
        self.model = model
        self.isAuto = isAuto
        self.valueLabel = valueLabel
        self.providerLabel = providerLabel
        self.selectedOptionID = selectedOptionID
        self.inCatalog = inCatalog
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let task = container.decodeLossyStringIfPresent(forKey: .task), !task.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .task, in: container, debugDescription: "missing task id")
        }
        self.task = task
        label = container.decodeLossyStringIfPresent(forKey: .label) ?? task
        description = container.decodeLossyStringIfPresent(forKey: .description) ?? ""
        provider = container.decodeLossyStringIfPresent(forKey: .provider) ?? ""
        model = container.decodeLossyStringIfPresent(forKey: .model) ?? ""
        isAuto = container.decodeLossyBoolIfPresent(forKey: .isAuto)
        valueLabel = container.decodeLossyStringIfPresent(forKey: .valueLabel)
        providerLabel = container.decodeLossyStringIfPresent(forKey: .providerLabel)
        selectedOptionID = container.decodeLossyStringIfPresent(forKey: .selectedOptionID)
        inCatalog = container.decodeLossyBoolIfPresent(forKey: .inCatalog)
    }
}

/// `POST /api/model/set` with `scope=auxiliary`.
public struct AuxiliaryModelSetResponse: Decodable, Equatable, Sendable {
    public let ok: Bool?
    public let auxiliary: AuxiliaryModelsResponse?
}
