import Foundation

public struct CronJobsResponse: Decodable, Equatable {
    public let jobs: [CronJob]?
}

public struct CronMutationResponse: Decodable, Equatable {
    public let ok: Bool?
    public let job: CronJob?
    public let error: String?
}

public struct CronStatusResponse: Decodable, Equatable {
    let jobId: String?
    let running: Bool?
    let elapsed: Double?
    public let runningJobs: [String: Double]?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case jobId
        case running
        case elapsed
        case error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try container.decodeIfPresent(String.self, forKey: .jobId)
        elapsed = try container.decodeFlexibleDoubleIfPresent(forKey: .elapsed)
        error = try container.decodeIfPresent(String.self, forKey: .error)

        running = (try? container.decodeIfPresent(Bool.self, forKey: .running)) ?? nil
        runningJobs = (try? container.decodeIfPresent([String: Double].self, forKey: .running)) ?? nil
    }
}

public struct CronJob: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String {
        jobId ?? fallbackIdentity.value
    }

    public let jobId: String?
    public let name: String?
    public let prompt: String?
    let schedule: CronSchedule?
    let scheduleDisplay: String?
    public let nextRunAt: CronDateValue?
    public let lastRunAt: CronDateValue?
    let lastStatus: String?
    public let lastError: String?
    public let lastDeliveryError: String?
    public let deliver: String?
    public let skills: [String]?
    public let model: String?
    public let provider: String?
    public let profile: String?
    public let toastNotifications: Bool?
    /// Server-derived (TAL-296): the status, attention flag, Resume/Pause choice, and manual-run flag.
    let derivedState: String?
    public let needsAttention: Bool?
    public let resumable: Bool?
    public let running: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case jobId
        case name
        case prompt
        case schedule
        case scheduleDisplay
        case nextRunAt
        case lastRunAt
        case lastStatus
        case lastError
        case lastDeliveryError
        case deliver
        case skills
        case model
        case provider
        case profile
        case toastNotifications
        case derivedState
        case needsAttention
        case resumable
        case running
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = container.decodeLossyStringIfPresent(forKey: .id)
            ?? container.decodeLossyStringIfPresent(forKey: .jobId)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        prompt = container.decodeLossyStringIfPresent(forKey: .prompt)
        schedule = (try? container.decodeIfPresent(CronSchedule.self, forKey: .schedule)) ?? nil
        scheduleDisplay = container.decodeLossyStringIfPresent(forKey: .scheduleDisplay)
        nextRunAt = (try? container.decodeIfPresent(CronDateValue.self, forKey: .nextRunAt)) ?? nil
        lastRunAt = (try? container.decodeIfPresent(CronDateValue.self, forKey: .lastRunAt)) ?? nil
        lastStatus = container.decodeLossyStringIfPresent(forKey: .lastStatus)
        lastError = container.decodeLossyStringIfPresent(forKey: .lastError)
        lastDeliveryError = container.decodeLossyStringIfPresent(forKey: .lastDeliveryError)
        deliver = container.decodeLossyStringIfPresent(forKey: .deliver)
        skills = (try? container.decodeIfPresent([String].self, forKey: .skills)) ?? nil
        model = container.decodeLossyStringIfPresent(forKey: .model)
        provider = container.decodeLossyStringIfPresent(forKey: .provider)
        profile = container.decodeLossyStringIfPresent(forKey: .profile)
        toastNotifications = container.decodeLossyBoolIfPresent(forKey: .toastNotifications)
        derivedState = container.decodeLossyStringIfPresent(forKey: .derivedState)
        needsAttention = container.decodeLossyBoolIfPresent(forKey: .needsAttention)
        resumable = container.decodeLossyBoolIfPresent(forKey: .resumable)
        running = container.decodeLossyBoolIfPresent(forKey: .running)
    }

    public var displayName: String {
        if let name, !name.isEmpty {
            return name
        }

        if let scheduleText, !scheduleText.isEmpty {
            return scheduleText
        }

        return String(localized: "Untitled Task")
    }

    public var scheduleText: String? {
        scheduleDisplay ?? schedule?.displayText
    }

    var editableScheduleText: String? {
        schedule?.expression ?? schedule?.expr ?? schedule?.runAt ?? schedule?.every ?? scheduleDisplay
    }

    /// The server's `derived_state`; a server that omits it yields a neutral `.unknown`.
    public var status: CronJobStatus {
        switch derivedState {
        case "needs_attention": return .needsAttention
        case "schedule_error": return .scheduleError
        case "paused": return .paused
        case "off": return .off
        case "error": return .error
        case "active": return .active
        default: return .unknown
        }
    }
}

struct CronSchedule: Decodable, Equatable {
    let kind: String?
    let expression: String?
    let expr: String?
    let runAt: String?
    let every: String?

    enum CodingKeys: String, CodingKey {
        case kind
        case expression
        case expr
        case runAt
        case every
    }

    init(from decoder: Decoder) throws {
        if let container = try? decoder.singleValueContainer(),
           let value = try? container.decode(String.self) {
            kind = nil
            expression = value
            expr = nil
            runAt = nil
            every = nil
            return
        }

        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = container.decodeLossyStringIfPresent(forKey: .kind)
        expression = container.decodeLossyStringIfPresent(forKey: .expression)
        expr = container.decodeLossyStringIfPresent(forKey: .expr)
        runAt = container.decodeLossyStringIfPresent(forKey: .runAt)
        every = container.decodeLossyStringIfPresent(forKey: .every)
    }

    var displayText: String? {
        expression ?? expr ?? runAt ?? every ?? kind
    }
}

public struct CronOutputResponse: Decodable, Equatable {
    let jobId: String?
    public let outputs: [CronOutputItem]?

    enum CodingKeys: String, CodingKey {
        case jobId
        case outputs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try container.decodeIfPresent(String.self, forKey: .jobId)
        outputs = (try? container.decodeIfPresent([CronOutputItem].self, forKey: .outputs)) ?? nil
    }
}

public struct CronOutputItem: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String { fallbackIdentity.value }

    public let filename: String?
    public let content: String?

    public enum CodingKeys: String, CodingKey {
        case filename
        case content
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        filename = try container.decodeIfPresent(String.self, forKey: .filename)
        content = try container.decodeIfPresent(String.self, forKey: .content)
    }
}

/// `GET /api/crons/history`: newest-first run listing without content.
public struct CronHistoryResponse: Decodable, Equatable {
    let jobId: String?
    public let runs: [CronRunSummary]?
    public let total: Int?
    let offset: Int?

    public enum CodingKeys: String, CodingKey {
        case jobId
        case runs
        case total
        case offset
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = container.decodeLossyStringIfPresent(forKey: .jobId)
        total = container.decodeLossyIntIfPresent(forKey: .total)
        offset = container.decodeLossyIntIfPresent(forKey: .offset)

        // Skip malformed rows instead of dropping the whole page.
        runs = container.decodeLossyArrayIfPresent(CronRunSummary.self, forKey: .runs)
    }
}

public struct CronRunSummary: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String { filename ?? fallbackIdentity.value }

    public let filename: String?
    public let size: Int?
    public let modified: CronDateValue?
    public let usage: CronRunUsage?

    public enum CodingKeys: String, CodingKey {
        case filename
        case size
        case modified
        case usage
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        filename = container.decodeLossyStringIfPresent(forKey: .filename)
        size = container.decodeLossyIntIfPresent(forKey: .size)
        modified = try? container.decodeIfPresent(CronDateValue.self, forKey: .modified)
        usage = try? container.decodeIfPresent(CronRunUsage.self, forKey: .usage)
    }
}

/// Optional token/cost metadata the server parses from a run's front matter.
public struct CronRunUsage: Decodable, Equatable {
    public let model: String?
    let provider: String?
    public let estimatedCostUsd: Double?
    public let durationSeconds: Double?
    let inputTokens: Int?
    let outputTokens: Int?
    public let totalTokens: Int?

    public enum CodingKeys: String, CodingKey {
        case model
        case provider
        case estimatedCostUsd
        case durationSeconds
        case inputTokens
        case outputTokens
        case totalTokens
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        model = container.decodeLossyStringIfPresent(forKey: .model)
        provider = container.decodeLossyStringIfPresent(forKey: .provider)
        estimatedCostUsd = container.decodeLossyDoubleIfPresent(forKey: .estimatedCostUsd)
        durationSeconds = container.decodeLossyDoubleIfPresent(forKey: .durationSeconds)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        totalTokens = container.decodeLossyIntIfPresent(forKey: .totalTokens)
    }

    var isEmpty: Bool {
        model == nil && provider == nil && estimatedCostUsd == nil && durationSeconds == nil
            && inputTokens == nil && outputTokens == nil && totalTokens == nil
    }
}

/// `GET /api/crons/run`: one run's full output.
public struct CronRunDetailResponse: Decodable, Equatable {
    let jobId: String?
    let filename: String?
    public let content: String?
    public let snippet: String?
    let usage: CronRunUsage?

    public enum CodingKeys: String, CodingKey {
        case jobId
        case filename
        case content
        case snippet
        case usage
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = container.decodeLossyStringIfPresent(forKey: .jobId)
        filename = container.decodeLossyStringIfPresent(forKey: .filename)
        content = container.decodeLossyStringIfPresent(forKey: .content)
        snippet = container.decodeLossyStringIfPresent(forKey: .snippet)
        usage = try? container.decodeIfPresent(CronRunUsage.self, forKey: .usage)
    }
}

/// `GET /api/crons/recent`: one row per job that has ever completed, carrying
/// only that job's latest run, newest first. Not a run archive; `cronHistory` is.
public struct CronRecentCompletionsResponse: Decodable, Equatable {
    public let completions: [CronRecentCompletion]?

    public enum CodingKeys: String, CodingKey {
        case completions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Skip malformed rows instead of dropping the whole feed.
        completions = container.decodeLossyArrayIfPresent(CronRecentCompletion.self, forKey: .completions)
    }
}

/// The server orders the feed and owns `outcome`; the app renders both as sent.
public struct CronRecentCompletion: Decodable, Equatable, Identifiable {
    public enum Outcome: String, Decodable {
        case succeeded
        case failed
        case unknown
    }

    public var id: String { jobId }

    public let jobId: String
    public let name: String?
    public let outcome: Outcome
    /// Unix seconds; the server normalizes every completion time to a number.
    public let completedAt: Date?

    public enum CodingKeys: String, CodingKey {
        case jobId
        case name
        case outcome
        case completedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // A row without a job id cannot be identified or opened.
        guard let jobId = container.decodeLossyStringIfPresent(forKey: .jobId), !jobId.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .jobId, in: container, debugDescription: "Completion names no job"
            )
        }
        self.jobId = jobId
        name = container.decodeLossyStringIfPresent(forKey: .name)
        outcome = (try? container.decodeIfPresent(Outcome.self, forKey: .outcome)) ?? .unknown
        completedAt = (try? container.decodeIfPresent(Double.self, forKey: .completedAt))
            .map { Date(timeIntervalSince1970: $0) }
    }

    public var displayName: String {
        if let name, !name.isEmpty {
            return name
        }
        return String(localized: "Untitled Task")
    }
}

public struct CronDeliveryOptionsResponse: Decodable, Equatable {
    public let platforms: [CronDeliveryOption]?

    public enum CodingKeys: String, CodingKey {
        case platforms
    }

    init(platforms: [CronDeliveryOption]?) {
        self.platforms = platforms
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        platforms = (try? container.decodeIfPresent([CronDeliveryOption].self, forKey: .platforms)) ?? nil
    }
}

public struct CronDeliveryOption: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String { value ?? fallbackIdentity.value }

    let value: String?
    let label: String?

    public enum CodingKeys: String, CodingKey {
        case value
        case label
    }

    init(value: String?, label: String?) {
        self.value = value
        self.label = label
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = container.decodeLossyStringIfPresent(forKey: .value)
        label = container.decodeLossyStringIfPresent(forKey: .label)
    }
}

/// One selectable row in the cron deliver picker.
public struct CronDeliverPickerOption: Equatable, Identifiable {
    public let value: String
    public let label: String
    /// `true` when the row exists only to round-trip a draft value that the
    /// server did not list (unknown/legacy deliver target).
    public let isCustom: Bool

    public var id: String { value }
}

public enum CronDeliverPicker {
    /// Builds picker rows from server-provided delivery options.
    ///
    /// Returns `nil` when the picker should fall back to free-text entry:
    /// options missing/empty (endpoint failed or returned nothing usable) or
    /// the current draft value is blank (nothing safe to select).
    /// A current value outside the server list is preserved as an extra
    /// custom row instead of being clobbered. `initialValue` (the draft's
    /// deliver value when the editor opened) also keeps its custom row so an
    /// unknown/legacy value can be re-selected after choosing another option.
    public static func options(
        serverOptions: [CronDeliveryOption]?,
        currentValue: String,
        initialValue: String? = nil
    ) -> [CronDeliverPickerOption]? {
        let valid = serverRows(serverOptions)
        guard !valid.isEmpty else {
            return nil
        }

        let current = currentValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.isEmpty else {
            return nil
        }

        return appendingCustomRows(to: valid, currentValue: current, initialValue: initialValue)
    }

    /// Server rows with blank and duplicate values dropped; missing labels
    /// fall back to the raw value.
    static func serverRows(_ serverOptions: [CronDeliveryOption]?) -> [CronDeliverPickerOption] {
        var seenValues = Set<String>()
        return (serverOptions ?? []).compactMap { option in
            guard let value = option.value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty,
                  seenValues.insert(value).inserted else {
                return nil
            }

            let label = option.label?.trimmingCharacters(in: .whitespacesAndNewlines)
            return CronDeliverPickerOption(
                value: value,
                label: (label?.isEmpty == false ? label : nil) ?? value,
                isCustom: false
            )
        }
    }

    /// Adds a custom row for the initial and current values the server did
    /// not list, so an unknown/legacy value stays visible and re-selectable.
    static func appendingCustomRows(
        to rows: [CronDeliverPickerOption],
        currentValue: String,
        initialValue: String?
    ) -> [CronDeliverPickerOption] {
        var options = rows
        var knownValues = Set(rows.map(\.value))
        let initial = initialValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !initial.isEmpty, knownValues.insert(initial).inserted {
            options.append(CronDeliverPickerOption(value: initial, label: initial, isCustom: true))
        }
        let current = currentValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !current.isEmpty, knownValues.insert(current).inserted {
            options.append(CronDeliverPickerOption(value: current, label: current, isCustom: true))
        }
        return options
    }
}

public enum CronProfilePicker {
    /// Blank selects the server's own profile choice.
    static let serverDefaultValue = ""

    /// Builds the task editor's profile rows: "Server Default" first, then the
    /// server's profiles, then custom rows for a saved name the server no
    /// longer lists. Returns `nil` when the profile list is unavailable so the
    /// editor falls back to free-text entry (the same rule as `deliver`).
    public static func options(
        profiles: [ProfileSummary]?,
        currentValue: String,
        initialValue: String? = nil
    ) -> [CronDeliverPickerOption]? {
        guard let profiles else { return nil }

        let serverRows = CronDeliverPicker.serverRows(
            profiles.map { CronDeliveryOption(value: $0.normalizedName, label: $0.displayName) }
        )
        let serverDefault = CronDeliverPickerOption(
            value: serverDefaultValue,
            label: String(localized: "Server Default"),
            isCustom: false
        )
        return CronDeliverPicker.appendingCustomRows(
            to: [serverDefault] + serverRows,
            currentValue: currentValue,
            initialValue: initialValue
        )
    }
}

public enum CronJobStatus: Equatable {
    case active
    case paused
    case off
    case error
    case needsAttention
    case scheduleError
    case unknown

    public var label: String {
        switch self {
        case .active:
            return String(localized: "Active")
        case .paused:
            return String(localized: "Paused")
        case .off:
            return String(localized: "Off")
        case .error:
            return String(localized: "Error")
        case .needsAttention:
            return String(localized: "Needs Attention")
        case .scheduleError:
            return String(localized: "Schedule Error")
        case .unknown:
            return String(localized: "Unknown")
        }
    }
}

public struct CronJobEditorDraft: Equatable {
    public var name: String
    public var prompt: String
    public var schedule: String
    public var deliver: String
    var skillsText: String
    public var model: String
    public var provider: String
    public var profile: String
    public var toastNotifications: Bool

    public init(
        name: String = "",
        prompt: String = "",
        schedule: String = "",
        deliver: String = "local",
        skillsText: String = "",
        model: String = "",
        provider: String = "",
        profile: String = "",
        toastNotifications: Bool = true
    ) {
        self.name = name
        self.prompt = prompt
        self.schedule = schedule
        self.deliver = deliver
        self.skillsText = skillsText
        self.model = model
        self.provider = provider
        self.profile = profile
        self.toastNotifications = toastNotifications
    }

    public init(job: CronJob) {
        self.init(
            name: job.name ?? "",
            prompt: job.prompt ?? "",
            schedule: job.editableScheduleText ?? "",
            deliver: job.deliver ?? "local",
            skillsText: job.skills?.joined(separator: ", ") ?? "",
            model: job.model ?? "",
            provider: job.provider ?? "",
            profile: job.profile ?? "",
            toastNotifications: job.toastNotifications ?? true
        )
    }

    public var trimmedName: String? {
        Self.nonEmpty(name)
    }

    public var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var trimmedSchedule: String {
        schedule.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var trimmedDeliver: String? {
        Self.nonEmpty(deliver)
    }

    public var trimmedModel: String? {
        Self.nonEmpty(model)
    }

    public var trimmedProvider: String? {
        Self.nonEmpty(provider)
    }

    public var trimmedProfile: String? {
        Self.nonEmpty(profile)
    }

    public var skills: [String] {
        skillsText
            .split { character in
                character == "," || character == "\n"
            }
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    public var validationMessage: String? {
        if trimmedPrompt.isEmpty {
            return String(localized: "Prompt is required.")
        }

        if trimmedSchedule.isEmpty {
            return String(localized: "Schedule is required.")
        }

        return nil
    }

    /// Applies a model picked in the editor, or `nil` for "Server Default".
    ///
    /// Model and provider always move together: every picker option names
    /// both, and writing one without the other is how a job ends up asking a
    /// provider for a model it does not serve. Clearing blanks both, which the
    /// server reads as "use the selected profile's model".
    public mutating func applyModelSelection(_ option: ModelCatalogOption?) {
        model = option?.id ?? ""
        provider = option?.providerID ?? ""
    }

    /// The option the editor's Model row shows, or `nil` for "Server Default".
    /// A saved model the catalog no longer offers resolves to itself so the
    /// row keeps naming it instead of reading as unconfigured.
    public func modelSelection(in groups: [ModelCatalogGroup]) -> ModelCatalogOption? {
        guard let modelID = trimmedModel else { return nil }
        return groups
            .flatMap(\.slashAutocompleteModels)
            .firstMatchingSelection(modelID: modelID, providerID: trimmedProvider)
            ?? ModelCatalogOption(id: modelID, displayName: modelID, providerID: trimmedProvider)
    }

    /// `skillsText` stays the storage so a job created before the picker
    /// existed keeps round-tripping through the same comma-separated form.
    mutating func applySkillSelection(_ names: [String]) {
        skillsText = names.joined(separator: ", ")
    }

    /// Adds `name` if absent, removes it if present. A newly selected skill
    /// goes on the end rather than re-sorting a list the user just read.
    public mutating func toggleSkill(_ name: String) {
        var selection = skills
        if let index = selection.firstIndex(of: name) {
            selection.remove(at: index)
        } else {
            selection.append(name)
        }
        applySkillSelection(selection)
    }

    private static func nonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public struct CronDateValue: Decodable, Equatable {
    public let date: Date

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if let timestamp = try? container.decode(Double.self) {
            date = Date(timeIntervalSince1970: timestamp)
            return
        }

        let stringValue = try container.decode(String.self)
        if let timestamp = Double(stringValue) {
            date = Date(timeIntervalSince1970: timestamp)
            return
        }

        if let parsed = Self.isoFormatter.date(from: stringValue)
            ?? Self.fractionalISOFormatter.date(from: stringValue) {
            date = parsed
            return
        }

        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported cron date value"
        )
    }

    public var formatted: String {
        Self.displayFormatter.string(from: date)
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractionalISOFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let displayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

extension KeyedDecodingContainer {
    func decodeFlexibleDoubleIfPresent(forKey key: Key) throws -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            return value
        }

        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            return Double(value)
        }

        if let stringValue = try? decodeIfPresent(String.self, forKey: key) {
            return Double(stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        return nil
    }
}
