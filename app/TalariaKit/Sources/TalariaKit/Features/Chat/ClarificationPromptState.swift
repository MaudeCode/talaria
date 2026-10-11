import Foundation

public struct ClarificationPromptState: Equatable, Identifiable {
    public var requestID: String { "\(sessionID)-\(pending.id)" }
    public var id: String { questionID.map { "\(requestID)-\($0)" } ?? requestID }

    let sessionID: String
    public let pending: PendingClarification
    public let pendingCount: Int
    public var questionIndex = 0

    private var activeStep: ClarificationStep? {
        guard let steps = pending.steps, steps.indices.contains(questionIndex) else { return nil }
        return steps[questionIndex]
    }

    var questionID: String? { activeStep?.qid }
    public var questionCount: Int { pending.steps?.count ?? 0 }
    public var isLastQuestion: Bool { questionIndex + 1 >= questionCount }
    public var isMultiSelect: Bool { activeStep?.multiSelect == true }
    public var question: String { activeStep?.question ?? "" }
    public var choices: [String] { activeStep?.choices ?? [] }
}
