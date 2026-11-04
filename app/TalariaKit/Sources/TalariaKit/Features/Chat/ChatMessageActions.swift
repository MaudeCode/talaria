import Foundation

public struct SelectableTextPresentation: Identifiable, Equatable, Sendable {
    public let id: String
    public let text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }

    public init(context: MessageActionContext) {
        self.init(id: context.messageID, text: context.copyText)
    }
}
