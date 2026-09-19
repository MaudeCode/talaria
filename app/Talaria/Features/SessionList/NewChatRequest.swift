import Foundation

/// A request from `ContentView` to open the New Chat composer. Carries whether voice
/// dictation should auto-start (the "New Chat with Voice" App Intent, #338) and an optional
/// profile name to pin the new session to (the "New Chat in <Profile>" App Intent, #339).
/// A fresh `id` each time so a repeat invocation re-triggers navigation even if the previous
/// value lingers.
struct NewChatRequest: Equatable {
    let id: UUID
    let autoStartsVoiceInput: Bool
    /// When set, the new session is created pinned to this profile; nil uses the server's
    /// active profile (the plain "+" / "New Chat" behavior).
    let profileName: String?
    let providerID: String?

    init(autoStartsVoiceInput: Bool = false, profileName: String? = nil, providerID: String? = nil) {
        self.id = UUID()
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.profileName = profileName
        self.providerID = providerID
    }
}
