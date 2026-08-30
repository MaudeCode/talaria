import SwiftUI
import UIKit

struct ComposerSecondaryControlsState: Equatable {
    struct GitBranch: Equatable {
        let currentName: String
        let branches: GitBranches?
        let isLoading: Bool
        let isSwitching: Bool
    }

    let workspaceTitle: String?
    let profileOptions: [ProfileSummary]
    let selectedProfileName: String?
    let selectedProfileTitle: String?
    let gitBranch: GitBranch?
    let contextWindowSnapshot: ContextWindowSnapshot?
    let showsContextUsage: Bool
    let isDisabled: Bool

    var hasControls: Bool {
        workspaceTitle != nil
            || selectedProfileTitle != nil
            || gitBranch != nil
            || showsContextUsage
    }
}


struct ComposerSecondaryControlsMenu: View {
    let state: ComposerSecondaryControlsState
    let onChooseWorkspace: () -> Void
    let onSelectProfile: (ProfileSummary) -> Void
    let onSelectGitBranch: (GitCheckoutTarget) -> Void
    let onCreateGitBranch: (GitCheckoutTarget) -> Void
    let onRefreshGitBranches: () -> Void

    @State private var showsContextDetails = false
    @State private var showsCreateBranchPrompt = false
    @State private var newBranchName = ""

    var body: some View {
        Menu {
            if let workspaceTitle = state.workspaceTitle {
                Button("Workspace: \(workspaceTitle)", systemImage: "folder", action: onChooseWorkspace)
                    .disabled(state.isDisabled)
            }

            if let selectedProfileTitle = state.selectedProfileTitle {
                Menu("Profile: \(selectedProfileTitle)", systemImage: "person.crop.circle") {
                    if state.profileOptions.isEmpty {
                        Text("No profiles available")
                    } else {
                        ForEach(state.profileOptions, id: \.self) { profile in
                            Button {
                                onSelectProfile(profile)
                            } label: {
                                if profile.name == state.selectedProfileName {
                                    Label(profile.displayName, systemImage: "checkmark")
                                } else {
                                    Text(profile.displayName)
                                }
                            }
                        }
                    }
                }
                .disabled(state.isDisabled)
            }

            if let gitBranch = state.gitBranch {
                branchMenu(gitBranch)
            }

            if state.showsContextUsage {
                Button(contextMenuTitle, systemImage: "gauge.with.dots.needle.67percent") {
                    showsContextDetails = true
                }
                .disabled(state.contextWindowSnapshot == nil)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "slider.horizontal.3")
                    .font(AppFont.subheadline(weight: .medium))
                    .foregroundStyle(.tertiary)

                Text(summary)
                    .font(AppFont.subheadline())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)

                Image(systemName: "chevron.down")
                    .font(AppFont.caption2(weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Session options")
        .accessibilityValue(summary)
        .popover(isPresented: $showsContextDetails) {
            if let snapshot = state.contextWindowSnapshot {
                ContextWindowPopover(snapshot: snapshot)
                    .presentationCompactAdaptation(.none)
                    .presentationBackground(.clear)
            }
        }
        .alert("New Branch", isPresented: $showsCreateBranchPrompt) {
            TextField("talaria/my-feature", text: $newBranchName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                guard let gitBranch = state.gitBranch else { return }
                let name = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                onCreateGitBranch(
                    GitCheckoutTarget(ref: gitBranch.currentName, mode: .local, newBranch: name)
                )
            }
            .disabled(newBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Create the branch from the current HEAD and switch to it.")
        }
    }

    private var summary: String {
        let values = [
            state.workspaceTitle,
            state.selectedProfileTitle,
            state.showsContextUsage ? ContextWindowIndicatorPresentation(snapshot: state.contextWindowSnapshot).percentageLabel + "%" : nil,
        ].compactMap { $0 }
        return values.isEmpty ? String(localized: "Session options") : values.joined(separator: " · ")
    }

    private var contextMenuTitle: String {
        let percentage = ContextWindowIndicatorPresentation(snapshot: state.contextWindowSnapshot).percentageLabel
        return String(localized: "Context: \(percentage)%")
    }

    private func branchMenu(_ gitBranch: ComposerSecondaryControlsState.GitBranch) -> some View {
        Menu("Branch: \(gitBranch.currentName)", systemImage: "arrow.triangle.branch") {
            if let local = gitBranch.branches?.local, !local.isEmpty {
                Section("Local") {
                    ForEach(Array(local.enumerated()), id: \.offset) { _, branch in
                        branchButton(branch, mode: .local, currentName: gitBranch.currentName)
                    }
                }
            }

            if let remote = gitBranch.branches?.remote, !remote.isEmpty {
                Section("Remote") {
                    ForEach(Array(remote.enumerated()), id: \.offset) { _, branch in
                        branchButton(branch, mode: .remote, currentName: gitBranch.currentName)
                    }
                }
            }

            Section {
                Button("New branch…", systemImage: "plus") {
                    newBranchName = ""
                    showsCreateBranchPrompt = true
                }
                .disabled(state.isDisabled || gitBranch.isSwitching)

                Button("Reload branch list", systemImage: "arrow.clockwise", action: onRefreshGitBranches)
                    .disabled(gitBranch.isLoading || gitBranch.isSwitching)
            }
        }
        .disabled(state.isDisabled)
    }

    private func branchButton(
        _ branch: GitBranchRef,
        mode: GitBranchMode,
        currentName: String
    ) -> some View {
        let name = branch.name ?? ""
        return Button {
            onSelectGitBranch(GitCheckoutTarget(ref: name, mode: mode, track: mode == .remote))
        } label: {
            if name == currentName {
                Label(name, systemImage: "checkmark")
            } else {
                Text(name)
            }
        }
        .disabled(name.isEmpty || name == currentName)
    }
}








struct ReasoningEffortOption: Identifiable, CaseIterable {
    let id: String
    let title: String

    static let allCases: [ReasoningEffortOption] = [
        ReasoningEffortOption(id: "none", title: String(localized: "None")),
        ReasoningEffortOption(id: "minimal", title: String(localized: "Minimal")),
        ReasoningEffortOption(id: "low", title: String(localized: "Low")),
        ReasoningEffortOption(id: "medium", title: String(localized: "Medium")),
        ReasoningEffortOption(id: "high", title: String(localized: "High")),
        ReasoningEffortOption(id: "xhigh", title: String(localized: "XHigh"))
    ]

    static func title(for effort: String) -> String {
        allCases.first(where: { $0.id == effort })?.title
            ?? effort.capitalized
    }

    /// Menu options for a server-provided effort vocabulary (issue #18).
    /// `nil` or empty → the full static list (older servers / defensive fallback;
    /// an empty list also means `supports_reasoning_effort == false`, which hides
    /// the control before this is ever rendered). Unknown ids are kept with a
    /// capitalized title so a newer server's vocabulary still works.
    static func options(forSupportedEfforts supportedEfforts: [String]?) -> [ReasoningEffortOption] {
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
