import Foundation
import Observation

/// AuxiliaryModelsResponse owns confirmed values; Draft owns only the user's local edits.
@MainActor
@Observable
public final class AuxiliaryModelsViewModel {
    public private(set) var tasks: [AuxiliaryModelTask] = []
    public private(set) var isLoading = false
    public private(set) var isUnavailable = false
    public private(set) var errorMessage: String?
    public private(set) var saveErrorMessage: String?
    public private(set) var savingTaskID: String?
    public static let resetTaskID = "__reset__"

    /// Extends the server task with device-local editor state, rather than another task projection.
    public struct Draft: Identifiable, Equatable {
        public let id = UUID()
        public fileprivate(set) var original: AuxiliaryModelTask
        public var model: String?
        public var provider: String?
        public var modelLabel: String
        public var effort: String?
        public var writesReasoning = false
        public var options: [String]?
        public var capabilityError: String?
        public var isLoadingCapability = false
        public var hasChanges: Bool { model != nil || writesReasoning }
        fileprivate var revision = 0
    }

    public private(set) var draft: Draft?
    public private(set) var catalog: SettingsModelPickerViewModel
    private let client: APIClient
    private let server: URL
    private var scope: Int
    private var loadGeneration = 0
    private var capabilityGeneration = 0
    private var loadedAt: Date?
    private var confirmedTasks: [AuxiliaryModelTask] = []
    private var loadTask: Task<Void, Never>?

    public init(server: URL, client: APIClient? = nil) {
        self.server = server
        let client = client ?? APIClient(baseURL: server)
        self.client = client
        scope = ActiveServerProfile.switchCount(for: server)
        catalog = SettingsModelPickerViewModel(client: client, favorites: .shared)
    }

    public func task(id: String) -> AuxiliaryModelTask? { tasks.first { $0.task == id } }

    public func loadIfNeeded() async {
        checkScope()
        guard loadedAt.map({ Date().timeIntervalSince($0) < 60 }) != true else { return }
        await load()
    }

    public func load() async { await load(reconcilingWrite: false) }

    private func load(reconcilingWrite: Bool) async {
        checkScope()
        if let loadTask { await loadTask.value; return }
        let generation = loadGeneration
        let scope = scope
        let work = Task { @MainActor in
            isLoading = true
            errorMessage = nil
            defer { if generation == loadGeneration { isLoading = false; loadTask = nil } }
            do {
                let response = try await client.auxiliaryModels()
                guard accepts(scope), generation == loadGeneration, reconcilingWrite || savingTaskID == nil else { return }
                apply(response)
                loadedAt = Date()
            } catch {
                guard accepts(scope), generation == loadGeneration else { return }
                if case APIError.http(statusCode: 404, _) = error {
                    isUnavailable = true
                } else if !APIError.isCancellation(error) {
                    errorMessage = error.localizedDescription
                }
            }
        }
        loadTask = work
        await work.value
    }

    public func beginEditing(task id: String) {
        checkScope()
        guard let shown = task(id: id) else { return }
        let confirmed = confirmedTasks.first { $0.task == id } ?? shown
        let editedRoute = shown.model != confirmed.model || shown.provider != confirmed.provider
        capabilityGeneration += 1
        saveErrorMessage = nil
        // Recover our unconfirmed choice without presenting it as a server-confirmed value.
        draft = Draft(original: confirmed, model: editedRoute ? shown.model : nil,
                      provider: editedRoute ? shown.provider : nil, modelLabel: shown.valueLabel ?? shown.model,
                      effort: shown.reasoning?.saved,
                      writesReasoning: shown.reasoning?.saved != confirmed.reasoning?.saved,
                      options: editedRoute ? nil : confirmed.reasoning?.options)
    }

    public func cancelEditing() {
        capabilityGeneration += 1
        draft = nil
        saveErrorMessage = nil
    }

    public func selectEffort(_ effort: String?) {
        checkScope()
        guard let draft, effort.map({ draft.options?.contains($0) == true }) ?? true else { return }
        self.draft?.effort = effort
        self.draft?.writesReasoning = true
        self.draft?.revision += 1
    }

    public func preserveReasoning() { draft?.writesReasoning = false; draft?.revision += 1 }

    /// The shared picker supplies identity and wording; the server supplies the new model's vocabulary.
    public func selectModel(_ model: String, provider: String?, label: String? = nil) async {
        checkScope()
        guard let draft else { return }
        capabilityGeneration += 1
        let generation = capabilityGeneration
        let scope = scope
        self.draft?.revision += 1
        self.draft?.model = model
        self.draft?.provider = provider
        self.draft?.modelLabel = model.isEmpty ? String(localized: "Auto") : label ?? model
        self.draft?.writesReasoning = false
        self.draft?.effort = draft.original.reasoning?.saved
        self.draft?.capabilityError = nil
        // Auto can inherit a different task, so only its slot projection knows the right vocabulary.
        self.draft?.options = nil
        guard !model.isEmpty, let reasoning = draft.original.reasoning,
              reasoning.unavailable == nil || reasoning.unavailable == "model" else { return }
        self.draft?.isLoadingCapability = true
        defer {
            if generation == capabilityGeneration { self.draft?.isLoadingCapability = false }
        }
        do {
            let response = try await client.reasoning(model: model, provider: provider)
            guard accepts(scope), generation == capabilityGeneration, self.draft?.id == draft.id else { return }
            self.draft?.options = response.supportsReasoningEffort == true ? response.supportedEfforts : nil
        } catch {
            guard accepts(scope), generation == capabilityGeneration, self.draft?.id == draft.id else { return }
            if !APIError.isCancellation(error) { self.draft?.capabilityError = error.localizedDescription }
        }
    }

    @discardableResult
    public func saveDraft() async -> Bool {
        checkScope()
        guard let draft, draft.hasChanges else { return false }
        let saved = await save(task: draft.original.task, model: draft.model, provider: draft.provider,
                               reasoningEffort: draft.effort, writesReasoning: draft.writesReasoning)
        guard self.draft?.id == draft.id, self.draft?.revision == draft.revision else { return false }
        if saved { cancelEditing() }
        return saved
    }

    @discardableResult
    public func save(task: String, model: String?, provider: String?, reasoningEffort: String? = nil,
                     writesReasoning: Bool = false) async -> Bool {
        checkScope()
        guard savingTaskID == nil else { return false }
        let scope = scope
        let editID = draft?.id
        savingTaskID = task
        saveErrorMessage = nil
        invalidateLoads()
        let confirmed = tasks
        // Predict only the user's explicit values. Effective routes and capabilities still come from the reply.
        tasks = tasks.map { current in
            guard current.task == task || task == Self.resetTaskID else { return current }
            let reset = task == Self.resetTaskID
            let changedRoute = model != nil || reset
            return AuxiliaryModelTask(task: current.task, label: current.label, description: current.description,
                provider: changedRoute ? (reset ? "auto" : provider ?? "") : current.provider,
                model: changedRoute ? (reset ? "" : model ?? "") : current.model,
                isAuto: changedRoute ? (reset || model == "") : current.isAuto,
                valueLabel: changedRoute ? (reset || model == "" ? String(localized: "Auto") : model) : current.valueLabel,
                providerLabel: changedRoute ? (reset || model == "" ? nil : provider) : current.providerLabel,
                selectedOptionID: changedRoute ? (reset || model == "" ? nil : model) : current.selectedOptionID,
                inCatalog: changedRoute ? nil : current.inCatalog,
                reasoning: current.reasoning.map {
                    AuxiliaryReasoning(saved: writesReasoning || reset ? reasoningEffort : $0.saved,
                        effective: $0.effective, inherited: writesReasoning || reset ? reasoningEffort == nil : $0.inherited,
                        defaultSource: $0.defaultSource, options: $0.options, unavailable: $0.unavailable)
                })
        }
        defer { if accepts(scope) { savingTaskID = nil } }
        do {
            let response = try await client.setAuxiliaryModel(task: task, model: model, provider: provider,
                reasoningEffort: reasoningEffort, writesReasoning: writesReasoning)
            guard accepts(scope) else { return false }
            invalidateLoads()
            guard response.ok == true else {
                tasks = confirmed
                if draft?.id == editID { saveErrorMessage = String(localized: "The server did not confirm the change.") }
                return false
            }
            if let auxiliary = response.auxiliary, auxiliary.isSupported { apply(auxiliary) }
            else { await load(reconcilingWrite: true) }
            return true
        } catch {
            guard accepts(scope) else { return false }
            invalidateLoads()
            if draft?.id == editID && !APIError.isCancellation(error) { saveErrorMessage = error.localizedDescription }
            if APIError.isDefinitiveWriteFailure(error) { tasks = confirmed }
            else { loadedAt = nil; await load(reconcilingWrite: true) }
            return false
        }
    }

    @discardableResult
    public func resetAll() async -> Bool {
        let saved = await save(task: Self.resetTaskID, model: "", provider: "auto")
        if saved { cancelEditing() }
        return saved
    }
    public func clearSaveError() { saveErrorMessage = nil }

    private func accepts(_ scope: Int) -> Bool {
        checkScope()
        return self.scope == scope
    }

    private func checkScope() {
        let current = ActiveServerProfile.switchCount(for: server)
        guard scope != current else { return }
        scope = current
        loadGeneration += 1
        capabilityGeneration += 1
        loadTask = nil
        loadedAt = nil
        tasks = []
        confirmedTasks = []
        draft = nil
        savingTaskID = nil
        isLoading = false
        isUnavailable = false
        errorMessage = nil
        saveErrorMessage = nil
        catalog = SettingsModelPickerViewModel(client: client, favorites: .shared)
    }

    private func invalidateLoads() {
        loadGeneration += 1
        loadTask = nil
        isLoading = false
    }

    private func apply(_ response: AuxiliaryModelsResponse) {
        isUnavailable = !response.isSupported
        tasks = response.isSupported ? response.tasks : []
        confirmedTasks = tasks
        if var draft, let confirmed = task(id: draft.original.task) {
            draft.original = confirmed
            if draft.model == nil {
                draft.modelLabel = confirmed.valueLabel ?? confirmed.model
                draft.options = confirmed.reasoning?.options
                if !draft.writesReasoning { draft.effort = confirmed.reasoning?.saved }
            }
            self.draft = draft
        }
    }
}
