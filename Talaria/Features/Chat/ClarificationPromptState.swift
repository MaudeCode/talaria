struct ClarificationPromptState: Equatable, Identifiable {
    var id: String {
        "\(sessionID)-\(pending.id)"
    }

    let sessionID: String
    let pending: PendingClarification
    let pendingCount: Int

    var question: String {
        pending.displayQuestion
    }

    var choices: [String] {
        pending.displayChoices
    }
}
