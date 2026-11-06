import Foundation

/// TAL-1321: the connection operation a chat shows: the server's last view, and the user's own answers on top of it
/// until the server settles each one. No answer's credentials are ever held here.
struct ConnectionOperationState: Equatable, Sendable {
    let sessionID: String
    var confirmed: ConnectorOperationView
    /// Answers on their way to the server.
    var inFlight: Set<ConnectorOperationMove> = []
    /// Answers whose outcome was lost. Nothing else can be sent until a read says what landed; none is ever replayed.
    var unknown: Set<ConnectorOperationMove> = []
    var errorMessage: String?

    private var answers: Set<ConnectorOperationMove> { inFlight.union(unknown) }

    /// Continue ended the wait from the user's side, so the card is gone until the server refuses it.
    var isContinuing: Bool { answers.contains(.continueWithoutTheRest) }

    /// Approve and Try again run an install or authorization only the server can finish, so they show busy instead.
    var runningTargets: Set<String> {
        Set(answers.compactMap { move in
            if case .row(let action, let target) = move, action != .skip { target } else { nil }
        })
    }

    var displayed: ConnectorOperationView {
        let answers = answers
        return confirmed.with(
            targets: confirmed.targets.map { target in
                if answers.contains(.row(.skip, target: target.name)) { return target.skipped() }
                return unknown.isEmpty ? target : target.withoutMoves()
            },
            // Continue ends the wait for the rest, so it never races a row's answer.
            canContinue: confirmed.canContinue && answers.isEmpty
        )
    }

    /// The check at dispatch: the server offers this move now, and no answer already on its way covers it.
    func offers(_ move: ConnectorOperationMove) -> Bool {
        guard !confirmed.settled, !isContinuing else { return false }
        switch move {
        case .continueWithoutTheRest:
            return displayed.canContinue
        case .row(let action, let name):
            return !runningTargets.contains(name)
                && displayed.targets.first { $0.name == name }?.actions.contains(action) == true
        }
    }

    /// Whether the server's view still offers `move`, which means a lost answer to it did not land.
    func confirmedOffers(_ move: ConnectorOperationMove) -> Bool {
        switch move {
        case .continueWithoutTheRest: confirmed.canContinue
        case .row(let action, let name): confirmed.targets.first { $0.name == name }?.actions.contains(action) == true
        }
    }
}
