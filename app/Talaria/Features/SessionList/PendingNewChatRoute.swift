import Foundation
import TalariaKit

struct PendingNewChatRoute: Identifiable, Hashable {
    let id = UUID()
    let initialDraft: String
    let initialAttachments: [SharedAttachmentImport]
    /// When true, the composer auto-starts voice dictation on appear (#338).
    let autoStartsVoiceInput: Bool
    /// When set, the new session is created pinned to this profile (#339).
    let profileName: String?
    let providerID: String?

    init(
        initialDraft: String = "",
        initialAttachments: [SharedAttachmentImport] = [],
        autoStartsVoiceInput: Bool = false,
        profileName: String? = nil,
        providerID: String? = nil
    ) {
        self.initialDraft = initialDraft
        self.initialAttachments = initialAttachments
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.profileName = profileName
        self.providerID = providerID
    }

    static func == (lhs: PendingNewChatRoute, rhs: PendingNewChatRoute) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
