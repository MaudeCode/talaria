import XCTest
@testable import TalariaKit

/// One action list serves the long-press menu and VoiceOver, so the states it
/// reports are asserted once, here (TAL-49).
final class ChatMessageActionCatalogTests: XCTestCase {
    func testAssistantMessageOffersItsFullActionList() {
        XCTAssertEqual(
            ids(for: .assistant, state: idleState),
            ["listen", "select-text", "regenerate", "fork", "copy"]
        )
    }

    func testUserMessageOffersEditInsteadOfAssistantActions() {
        XCTAssertEqual(ids(for: .user, state: idleState), ["edit", "fork", "copy"])
    }

    func testListeningMessageOffersStoppingInstead() {
        let actions = catalog(for: .assistant, state: ChatMessageActionState(
            listeningMessageID: messageID,
            isViewingCachedData: false,
            isSessionReadOnly: false,
            hasActiveStream: false,
            isRegeneratingMessage: false,
            isEditingMessage: false,
            isForkingMessage: false,
            disablesHistoryActions: false
        ))

        XCTAssertEqual(actions.first?.title, "Stop Listening")
    }

    func testHistoryActionsAreDisabledWhileAStreamIsActive() {
        let actions = catalog(for: .assistant, state: ChatMessageActionState(
            listeningMessageID: nil,
            isViewingCachedData: false,
            isSessionReadOnly: false,
            hasActiveStream: true,
            isRegeneratingMessage: false,
            isEditingMessage: false,
            isForkingMessage: false,
            disablesHistoryActions: false
        ))

        XCTAssertEqual(disabledIDs(actions), ["regenerate", "fork"])
    }

    func testCachedTranscriptDisablesHistoryActionsButKeepsCopy() {
        let actions = catalog(for: .user, state: ChatMessageActionState(
            listeningMessageID: nil,
            isViewingCachedData: true,
            isSessionReadOnly: false,
            hasActiveStream: false,
            isRegeneratingMessage: false,
            isEditingMessage: false,
            isForkingMessage: false,
            disablesHistoryActions: false
        ))

        XCTAssertEqual(disabledIDs(actions), ["edit", "fork"])
        XCTAssertEqual(actions.last?.id, "copy")
        XCTAssertTrue(actions.last?.isEnabled == true)
    }

    func testReadOnlySessionDisablesEditAndRegenerateButKeepsFork() {
        let readOnly = ChatMessageActionState(
            listeningMessageID: nil,
            isViewingCachedData: false,
            isSessionReadOnly: true,
            hasActiveStream: false,
            isRegeneratingMessage: false,
            isEditingMessage: false,
            isForkingMessage: false,
            disablesHistoryActions: false
        )

        XCTAssertEqual(disabledIDs(catalog(for: .user, state: readOnly)), ["edit"])
        XCTAssertEqual(disabledIDs(catalog(for: .assistant, state: readOnly)), ["regenerate"])
    }

    func testServerBranchGateDisablesForkOnly() {
        var state = idleState
        state.canBranch = false

        XCTAssertEqual(disabledIDs(catalog(for: .assistant, state: state)), ["fork"])
        XCTAssertEqual(disabledIDs(catalog(for: .user, state: state)), ["fork"])
    }

    func testInFlightForkOnlyDisablesForking() {
        let actions = catalog(for: .assistant, state: ChatMessageActionState(
            listeningMessageID: nil,
            isViewingCachedData: false,
            isSessionReadOnly: false,
            hasActiveStream: false,
            isRegeneratingMessage: false,
            isEditingMessage: false,
            isForkingMessage: true,
            disablesHistoryActions: false
        ))

        XCTAssertEqual(disabledIDs(actions), ["fork"])
    }

    func testInvokingAnActionCallsItsHandlerWithTheMessageContext() {
        var forked: String?
        let actions = ChatMessageActionCatalog.actions(
            context: context(role: .assistant),
            state: idleState,
            handlers: handlers(onFork: { forked = $0.messageID })
        )
        actions.first { $0.id == "fork" }?.handler()

        XCTAssertEqual(forked, messageID)
    }

    private let messageID = "message-1"

    private var idleState: ChatMessageActionState {
        ChatMessageActionState(
            listeningMessageID: nil,
            isViewingCachedData: false,
            isSessionReadOnly: false,
            hasActiveStream: false,
            isRegeneratingMessage: false,
            isEditingMessage: false,
            isForkingMessage: false,
            disablesHistoryActions: false
        )
    }

    private func context(role: MessageActionContext.Role) -> MessageActionContext {
        let message = ChatMessage(
            role: role == .user ? "user" : "assistant",
            content: "fixture content",
            timestamp: 2_000_000_000,
            messageId: messageID
        )
        return MessageActionContext(message: message, visibleIndex: 0, messagesOffset: 0)!
    }

    private func catalog(
        for role: MessageActionContext.Role,
        state: ChatMessageActionState
    ) -> [ChatMessageAction] {
        ChatMessageActionCatalog.actions(
            context: context(role: role),
            state: state,
            handlers: handlers()
        )
    }

    private func ids(for role: MessageActionContext.Role, state: ChatMessageActionState) -> [String] {
        catalog(for: role, state: state).map(\.id)
    }

    private func disabledIDs(_ actions: [ChatMessageAction]) -> [String] {
        actions.filter { !$0.isEnabled }.map(\.id)
    }

    private func handlers(
        onFork: @escaping (MessageActionContext) -> Void = { _ in }
    ) -> ChatMessageActionHandlers {
        ChatMessageActionHandlers(
            onToggleListening: { _ in },
            onSelectText: { _ in },
            onRegenerate: { _ in },
            onEdit: { _ in },
            onFork: onFork,
            onCopy: { _ in }
        )
    }
}
