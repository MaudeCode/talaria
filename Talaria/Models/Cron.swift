import Foundation

struct CronJobsResponse: Decodable, Equatable {
    let jobs: [CronJob]?
}

struct CronMutationResponse: Decodable, Equatable {
    let ok: Bool?
    let job: CronJob?
    let error: String?
}

struct CronStatusResponse: Decodable, Equatable {
    let jobId: String?
    let running: Bool?
    let elapsed: Double?
    let runningJobs: [String: Double]?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case jobId
        case running
        case elapsed
        case error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try container.decodeIfPresent(String.self, forKey: .jobId)
        elapsed = try container.decodeFlexibleDoubleIfPresent(forKey: .elapsed)
        error = try container.decodeIfPresent(String.self, forKey: .error)

        running = (try? container.decodeIfPresent(Bool.self, forKey: .running)) ?? nil
        runningJobs = (try? container.decodeIfPresent([String: Double].self, forKey: .running)) ?? nil
    }
}

struct CronJob: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    var id: String {
        jobId ?? fallbackIdentity.value
    }

    let jobId: String?
    let name: String?
    let prompt: String?
    let schedule: CronSchedule?
    let scheduleDisplay: String?
    let enabled: Bool?
    let state: String?
    let nextRunAt: CronDateValue?
    let lastRunAt: CronDateValue?
    let lastStatus: String?
    let lastError: String?
    let lastDeliveryError: String?
    let repeatInfo: CronRepeat?
    let deliver: String?
    let skills: [String]?
    let model: String?
    let provider: String?
    let profile: String?
    let toastNotifications: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case jobId
        case name
        case prompt
        case schedule
        case scheduleDisplay
        case enabled
        case state
        case nextRunAt
        case lastRunAt
        case lastStatus
        case lastError
        case lastDeliveryError
        case repeatInfo = "repeat"
        case deliver
        case skills
        case model
        case provider
        case profile
        case toastNotifications
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = container.decodeLossyStringIfPresent(forKey: .id)
            ?? container.decodeLossyStringIfPresent(forKey: .jobId)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        prompt = container.decodeLossyStringIfPresent(forKey: .prompt)
        schedule = (try? container.decodeIfPresent(CronSchedule.self, forKey: .schedule)) ?? nil
        scheduleDisplay = container.decodeLossyStringIfPresent(forKey: .scheduleDisplay)
        enabled = container.decodeLossyBoolIfPresent(forKey: .enabled)
        state = container.decodeLossyStringIfPresent(forKey: .state)
        nextRunAt = (try? container.decodeIfPresent(CronDateValue.self, forKey: .nextRunAt)) ?? nil
        lastRunAt = (try? container.decodeIfPresent(CronDateValue.self, forKey: .lastRunAt)) ?? nil
        lastStatus = container.decodeLossyStringIfPresent(forKey: .lastStatus)
        lastError = container.decodeLossyStringIfPresent(forKey: .lastError)
        lastDeliveryError = container.decodeLossyStringIfPresent(forKey: .lastDeliveryError)
        repeatInfo = (try? container.decodeIfPresent(CronRepeat.self, forKey: .repeatInfo)) ?? nil
        deliver = container.decodeLossyStringIfPresent(forKey: .deliver)
        skills = (try? container.decodeIfPresent([String].self, forKey: .skills)) ?? nil
        model = container.decodeLossyStringIfPresent(forKey: .model)
        provider = container.decodeLossyStringIfPresent(forKey: .provider)
        profile = container.decodeLossyStringIfPresent(forKey: .profile)
        toastNotifications = container.decodeLossyBoolIfPresent(forKey: .toastNotifications)
    }

    var displayName: String {
        if let name, !name.isEmpty {
            return name
        }

        if let scheduleText, !scheduleText.isEmpty {
            return scheduleText
        }

        return String(localized: "Untitled Task")
    }

    var scheduleText: String? {
        scheduleDisplay ?? schedule?.displayText
    }

    var editableScheduleText: String? {
        schedule?.expression ?? schedule?.expr ?? schedule?.runAt ?? schedule?.every ?? scheduleDisplay
    }

    var status: CronJobStatus {
        if isRecurring,
           repeatInfo?.times == nil,
           enabled == false,
           state == "completed",
           nextRunAt == nil {
            return .needsAttention
        }

        if isRecurring,
           nextRunAt == nil,
           state == "error" || lastStatus == "error" {
            return .needsAttention
        }

        if state == "paused" {
            return .paused
        }

        if enabled == false {
            return .off
        }

        if lastStatus == "error" {
            return .error
        }

        return .active
    }

    private var isRecurring: Bool {
        schedule?.kind == "cron" || schedule?.kind == "interval"
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

struct CronRepeat: Decodable, Equatable {
    let times: Int?
    let completed: Int?
}

struct CronOutputResponse: Decodable, Equatable {
    let jobId: String?
    let outputs: [CronOutputItem]?

    enum CodingKeys: String, CodingKey {
        case jobId
        case outputs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try container.decodeIfPresent(String.self, forKey: .jobId)
        outputs = (try? container.decodeIfPresent([CronOutputItem].self, forKey: .outputs)) ?? nil
    }
}

struct CronOutputItem: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    var id: String { fallbackIdentity.value }

    let filename: String?
    let content: String?

    enum CodingKeys: String, CodingKey {
        case filename
        case content
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        filename = try container.decodeIfPresent(String.self, forKey: .filename)
        content = try container.decodeIfPresent(String.self, forKey: .content)
    }
}

struct CronDeliveryOptionsResponse: Decodable, Equatable {
    let platforms: [CronDeliveryOption]?

    enum CodingKeys: String, CodingKey {
        case platforms
    }

    init(platforms: [CronDeliveryOption]?) {
        self.platforms = platforms
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        platforms = (try? container.decodeIfPresent([CronDeliveryOption].self, forKey: .platforms)) ?? nil
    }
}

struct CronDeliveryOption: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    var id: String { value ?? fallbackIdentity.value }

    let value: String?
    let label: String?

    enum CodingKeys: String, CodingKey {
        case value
        case label
    }

    init(value: String?, label: String?) {
        self.value = value
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = container.decodeLossyStringIfPresent(forKey: .value)
        label = container.decodeLossyStringIfPresent(forKey: .label)
    }
}

/// One selectable row in the cron deliver picker.
struct CronDeliverPickerOption: Equatable, Identifiable {
    let value: String
    let label: String
    /// `true` when the row exists only to round-trip a draft value that the
    /// server did not list (unknown/legacy deliver target).
    let isCustom: Bool

    var id: String { value }
}

enum CronDeliverPicker {
    /// Builds picker rows from server-provided delivery options.
    ///
    /// Returns `nil` when the picker should fall back to free-text entry:
    /// options missing/empty (endpoint failed or returned nothing usable) or
    /// the current draft value is blank (nothing safe to select).
    /// A current value outside the server list is preserved as an extra
    /// custom row instead of being clobbered. `initialValue` (the draft's
    /// deliver value when the editor opened) also keeps its custom row so an
    /// unknown/legacy value can be re-selected after choosing another option.
    static func options(
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

enum CronProfilePicker {
    /// Blank selects the server's own profile choice.
    static let serverDefaultValue = ""

    /// Builds the task editor's profile rows: "Server Default" first, then the
    /// server's profiles, then custom rows for a saved name the server no
    /// longer lists. Returns `nil` when the profile list is unavailable so the
    /// editor falls back to free-text entry (the same rule as `deliver`).
    static func options(
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

enum CronJobStatus: Equatable {
    case active
    case paused
    case off
    case error
    case needsAttention

    var label: String {
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
        }
    }
}

struct CronJobEditorDraft: Equatable {
    var name: String
    var prompt: String
    var schedule: String
    var deliver: String
    var skillsText: String
    var model: String
    var provider: String
    var profile: String
    var toastNotifications: Bool

    init(
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

    init(job: CronJob) {
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

    var trimmedName: String? {
        Self.nonEmpty(name)
    }

    var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var trimmedSchedule: String {
        schedule.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var trimmedDeliver: String? {
        Self.nonEmpty(deliver)
    }

    var trimmedModel: String? {
        Self.nonEmpty(model)
    }

    var trimmedProvider: String? {
        Self.nonEmpty(provider)
    }

    var trimmedProfile: String? {
        Self.nonEmpty(profile)
    }

    var skills: [String] {
        skillsText
            .split { character in
                character == "," || character == "\n"
            }
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    var validationMessage: String? {
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
    mutating func applyModelSelection(_ option: ModelCatalogOption?) {
        model = option?.id ?? ""
        provider = option?.providerID ?? ""
    }

    /// The option the editor's Model row shows, or `nil` for "Server Default".
    /// A saved model the catalog no longer offers resolves to itself so the
    /// row keeps naming it instead of reading as unconfigured.
    func modelSelection(in groups: [ModelCatalogGroup]) -> ModelCatalogOption? {
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
    mutating func toggleSkill(_ name: String) {
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

struct CronDateValue: Decodable, Equatable {
    let date: Date

    init(from decoder: Decoder) throws {
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

    var formatted: String {
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
