import Foundation

public struct GoalSubmissionResponse: Decodable, Equatable {
    public let ok: Bool?
    public let action: String?
    let message: String?
    public let goal: SubmittedGoal?
    let kickoffPrompt: String?
    let decision: GoalDecision?

    public var displayMessage: String? {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    public var kickoffPromptText: String? {
        let trimmed = kickoffPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    enum CodingKeys: String, CodingKey {
        case ok
        case action
        case message
        case goal
        case kickoffPrompt
        case kickoffPromptSnake = "kickoff_prompt"
        case decision
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        action = container.decodeLossyStringIfPresent(forKey: .action)
        message = container.decodeLossyStringIfPresent(forKey: .message)
        goal = try? container.decodeIfPresent(SubmittedGoal.self, forKey: .goal)
        kickoffPrompt = container.decodeLossyStringIfPresent(forKey: .kickoffPrompt)
            ?? container.decodeLossyStringIfPresent(forKey: .kickoffPromptSnake)
        decision = try? container.decodeIfPresent(GoalDecision.self, forKey: .decision)
    }
}

public struct SubmittedGoal: Decodable, Equatable {
    let goal: String?
    public let status: String?
    let turnsUsed: Int?
    let maxTurns: Int?
    let lastVerdict: String?
    let lastReason: String?
    let pausedReason: String?

    enum CodingKeys: String, CodingKey {
        case goal
        case status
        case turnsUsed
        case turnsUsedSnake = "turns_used"
        case maxTurns
        case maxTurnsSnake = "max_turns"
        case lastVerdict
        case lastVerdictSnake = "last_verdict"
        case lastReason
        case lastReasonSnake = "last_reason"
        case pausedReason
        case pausedReasonSnake = "paused_reason"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        goal = container.decodeLossyStringIfPresent(forKey: .goal)
        status = container.decodeLossyStringIfPresent(forKey: .status)
        turnsUsed = container.decodeLossyIntIfPresent(forKey: .turnsUsed)
            ?? container.decodeLossyIntIfPresent(forKey: .turnsUsedSnake)
        maxTurns = container.decodeLossyIntIfPresent(forKey: .maxTurns)
            ?? container.decodeLossyIntIfPresent(forKey: .maxTurnsSnake)
        lastVerdict = container.decodeLossyStringIfPresent(forKey: .lastVerdict)
            ?? container.decodeLossyStringIfPresent(forKey: .lastVerdictSnake)
        lastReason = container.decodeLossyStringIfPresent(forKey: .lastReason)
            ?? container.decodeLossyStringIfPresent(forKey: .lastReasonSnake)
        pausedReason = container.decodeLossyStringIfPresent(forKey: .pausedReason)
            ?? container.decodeLossyStringIfPresent(forKey: .pausedReasonSnake)
    }
}

struct GoalDecision: Decodable, Equatable {
    let status: String?
    let shouldContinue: Bool?
    let continuationPrompt: String?
    let verdict: String?
    let reason: String?
    let message: String?
    let messageKey: String?
    let messageArgs: [JSONValue]?

    enum CodingKeys: String, CodingKey {
        case status
        case shouldContinue
        case shouldContinueSnake = "should_continue"
        case continuationPrompt
        case continuationPromptSnake = "continuation_prompt"
        case verdict
        case reason
        case message
        case messageKey
        case messageKeySnake = "message_key"
        case messageArgs
        case messageArgsSnake = "message_args"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = container.decodeLossyStringIfPresent(forKey: .status)
        shouldContinue = container.decodeLossyBoolIfPresent(forKey: .shouldContinue)
            ?? container.decodeLossyBoolIfPresent(forKey: .shouldContinueSnake)
        continuationPrompt = container.decodeLossyStringIfPresent(forKey: .continuationPrompt)
            ?? container.decodeLossyStringIfPresent(forKey: .continuationPromptSnake)
        verdict = container.decodeLossyStringIfPresent(forKey: .verdict)
        reason = container.decodeLossyStringIfPresent(forKey: .reason)
        message = container.decodeLossyStringIfPresent(forKey: .message)
        messageKey = container.decodeLossyStringIfPresent(forKey: .messageKey)
            ?? container.decodeLossyStringIfPresent(forKey: .messageKeySnake)
        messageArgs = (try? container.decodeIfPresent([JSONValue].self, forKey: .messageArgs))
            ?? (try? container.decodeIfPresent([JSONValue].self, forKey: .messageArgsSnake))
    }
}

/// TAL-808: the session's standing `/goal` while it runs (session `goal`); a done, cleared or absent goal is null.
/// `parked` is an active goal waiting on a process or a timer. Decoded with `convertFromSnakeCase`.
public struct SessionGoal: Decodable, Equatable {
    public enum Status: String, Equatable {
        case active, paused, parked
    }

    public let text: String
    public let status: Status
    public let turnsUsed: Int
    public let maxTurns: Int
    /// Why it is paused, or what a park waits on.
    public let reason: String?
    /// When a timed park ends, in Unix seconds; nil for an untimed park and every other status.
    public let parkedUntil: Double?

    public init(text: String, status: Status, turnsUsed: Int, maxTurns: Int, reason: String? = nil, parkedUntil: Double? = nil) {
        self.text = text
        self.status = status
        self.turnsUsed = turnsUsed
        self.maxTurns = maxTurns
        self.reason = reason
        self.parkedUntil = parkedUntil
    }

    enum CodingKeys: String, CodingKey {
        case text, status, turnsUsed, maxTurns, reason, parkedUntil
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // A goal missing what the chip shows is dropped rather than shown with invented values.
        guard let status = container.decodeLossyStringIfPresent(forKey: .status).flatMap(Status.init(rawValue:)),
              let text = container.decodeLossyStringIfPresent(forKey: .text),
              let turnsUsed = container.decodeLossyIntIfPresent(forKey: .turnsUsed),
              let maxTurns = container.decodeLossyIntIfPresent(forKey: .maxTurns)
        else {
            throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "A session goal needs a known status, its text and its turns")
        }
        self.status = status
        self.text = text
        self.turnsUsed = turnsUsed
        self.maxTurns = maxTurns
        reason = container.decodeLossyStringIfPresent(forKey: .reason)
        parkedUntil = container.decodeLossyDoubleIfPresent(forKey: .parkedUntil)
    }
}
