import Foundation

struct ClarificationPromptState: Equatable, Identifiable {
    var requestID: String { "\(sessionID)-\(pending.id)" }
    var id: String { questionID.map { "\(requestID)-\($0)" } ?? requestID }

    let sessionID: String
    let pending: PendingClarification
    let pendingCount: Int
    var questionIndex = 0

    var activeQuestion: ClarificationQuestion? {
        guard let questions = pending.questions, questions.indices.contains(questionIndex) else { return nil }
        return questions[questionIndex]
    }

    var questionID: String? {
        guard let activeQuestion else { return nil }
        let qid = activeQuestion.qid?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return qid.isEmpty ? "q\(questionIndex)" : qid
    }

    var questionCount: Int { max(pending.questions?.count ?? 1, 1) }
    var isLastQuestion: Bool { questionIndex + 1 >= questionCount }
    var isMultiSelect: Bool { activeQuestion?.multiSelect == true && !choices.isEmpty }

    var question: String {
        let text = activeQuestion?.question?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? pending.displayQuestion : text
    }

    var choices: [String] {
        guard let activeQuestion else { return pending.displayChoices }
        return (activeQuestion.choices ?? []).compactMap {
            let text = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
    }
}
