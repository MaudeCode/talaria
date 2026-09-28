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

    // Old-server fallback. Delete the raw-question path once all supported servers ship steps.
    var activeQuestion: ClarificationQuestion? {
        guard let questions = pending.questions, questions.indices.contains(questionIndex) else { return nil }
        return questions[questionIndex]
    }

    var questionID: String? {
        if pending.steps != nil { return activeStep?.qid }
        guard let activeQuestion else { return nil }
        let qid = activeQuestion.qid?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return qid.isEmpty ? "q\(questionIndex)" : qid
    }

    public var questionCount: Int { pending.steps?.count ?? max(pending.questions?.count ?? 1, 1) }
    public var isLastQuestion: Bool { questionIndex + 1 >= questionCount }
    public var isMultiSelect: Bool {
        if pending.steps != nil { return activeStep?.multiSelect == true }
        return activeQuestion?.multiSelect == true && !choices.isEmpty
    }

    public var question: String {
        if pending.steps != nil { return activeStep?.question ?? "" }
        let text = activeQuestion?.question?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? pending.displayQuestion : text
    }

    public var choices: [String] {
        if pending.steps != nil { return activeStep?.choices ?? [] }
        guard let activeQuestion else { return pending.displayChoices }
        return (activeQuestion.choices ?? []).compactMap {
            let text = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
    }
}
