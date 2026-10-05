import SwiftUI

/// The selectors in the composer's control strip, after model and reasoning (TAL-629).
public struct ComposerSecondaryControlsState: Equatable {

    public init(workspaceTitle: String?, profileOptions: [ProfileSummary], selectedProfileName: String?, selectedProfileTitle: String?, gitBranch: ComposerSecondaryControlsState.GitBranch?, toolsetsTitle: String? = nil, isDisabled: Bool) {
        self.workspaceTitle = workspaceTitle
        self.toolsetsTitle = toolsetsTitle
        self.profileOptions = profileOptions
        self.selectedProfileName = selectedProfileName
        self.selectedProfileTitle = selectedProfileTitle
        self.gitBranch = gitBranch
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

    public enum Selector: Hashable {
        case workspace
        case gitBranch
        case toolsets
        case profile
    }

    public let workspaceTitle: String?
    public let profileOptions: [ProfileSummary]
    public let selectedProfileName: String?
    public let selectedProfileTitle: String?
    public let gitBranch: GitBranch?
    /// The session's toolsets (TAL-631); nil hides the control.
    public let toolsetsTitle: String?
    public let isDisabled: Bool

    /// The selectors the strip shows, by how often each changes: workspace, git branch, toolsets, then profile.
    public var selectors: [Selector] {
        [
            workspaceTitle == nil ? nil : .workspace,
            gitBranch == nil ? nil : .gitBranch,
            toolsetsTitle == nil ? nil : .toolsets,
            selectedProfileTitle == nil ? nil : .profile,
        ].compactMap { $0 }
    }
}

/// Which ends of the control strip fade: only an edge that hides content (TAL-629).
public struct ComposerStripEdgeFades: Equatable {
    public let leading: Bool
    public let trailing: Bool

    public init(leading: Bool, trailing: Bool) {
        self.leading = leading
        self.trailing = trailing
    }

    public init(contentOffset: CGFloat, contentWidth: CGFloat, containerWidth: CGFloat) {
        // Half a point of slack absorbs rounding at either end.
        leading = contentOffset > 0.5
        trailing = contentOffset + containerWidth < contentWidth - 0.5
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
