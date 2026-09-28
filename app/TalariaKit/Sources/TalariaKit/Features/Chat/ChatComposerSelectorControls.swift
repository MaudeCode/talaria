import SwiftUI

public struct ComposerSecondaryControlsState: Equatable {

    public init(workspaceTitle: String?, profileOptions: [ProfileSummary], selectedProfileName: String?, selectedProfileTitle: String?, gitBranch: ComposerSecondaryControlsState.GitBranch?, contextWindowSnapshot: ContextWindowSnapshot?, showsContextUsage: Bool, isDisabled: Bool) {
        self.workspaceTitle = workspaceTitle
        self.profileOptions = profileOptions
        self.selectedProfileName = selectedProfileName
        self.selectedProfileTitle = selectedProfileTitle
        self.gitBranch = gitBranch
        self.contextWindowSnapshot = contextWindowSnapshot
        self.showsContextUsage = showsContextUsage
        self.isDisabled = isDisabled
    }

    public struct GitBranch: Equatable {
        public let currentName: String
        public let branches: GitBranches?
        public let isLoading: Bool
        public let isSwitching: Bool

        public init(currentName: String, branches: GitBranches?, isLoading: Bool, isSwitching: Bool) {
            self.currentName = currentName
            self.branches = branches
            self.isLoading = isLoading
            self.isSwitching = isSwitching
        }
    }

    public let workspaceTitle: String?
    public let profileOptions: [ProfileSummary]
    public let selectedProfileName: String?
    public let selectedProfileTitle: String?
    public let gitBranch: GitBranch?
    public let contextWindowSnapshot: ContextWindowSnapshot?
    public let showsContextUsage: Bool
    public let isDisabled: Bool

    public var hasControls: Bool {
        workspaceTitle != nil
            || selectedProfileTitle != nil
            || gitBranch != nil
            || showsContextUsage
    }
}


public struct ReasoningEffortOption: Identifiable, CaseIterable {
    public let id: String
    public let title: String

    public static let allCases: [ReasoningEffortOption] = [
        ReasoningEffortOption(id: "none", title: String(localized: "None")),
        ReasoningEffortOption(id: "minimal", title: String(localized: "Minimal")),
        ReasoningEffortOption(id: "low", title: String(localized: "Low")),
        ReasoningEffortOption(id: "medium", title: String(localized: "Medium")),
        ReasoningEffortOption(id: "high", title: String(localized: "High")),
        ReasoningEffortOption(id: "xhigh", title: String(localized: "XHigh"))
    ]

    public static func title(for effort: String) -> String {
        allCases.first(where: { $0.id == effort })?.title
            ?? effort.capitalized
    }

    /// Menu options for a server-provided effort vocabulary (issue #18).
    /// `nil` or empty → the full static list (older servers / defensive fallback;
    /// an empty list also means `supports_reasoning_effort == false`, which hides
    /// the control before this is ever rendered). Unknown ids are kept with a
    /// capitalized title so a newer server's vocabulary still works.
    public static func options(forSupportedEfforts supportedEfforts: [String]?) -> [ReasoningEffortOption] {
        guard let supportedEfforts, !supportedEfforts.isEmpty else { return allCases }

        var seen = Set<String>()
        return supportedEfforts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { id in
                allCases.first(where: { $0.id == id })
                    ?? ReasoningEffortOption(id: id, title: id.capitalized)
            }
    }

    /// Whether the composer should show the effort control at all (issue #18).
    /// `supports_reasoning_effort == false` hides it; older servers (both fields
    /// absent) keep today's behavior and show it.
    static func showsEffortControl(
        supportsReasoningEffort: Bool?,
        supportedEfforts: [String]?
    ) -> Bool {
        if let supportsReasoningEffort { return supportsReasoningEffort }
        if let supportedEfforts { return !supportedEfforts.isEmpty }
        return true
    }
}
