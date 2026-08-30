import SwiftUI
import UIKit


@MainActor
final class NavigationBarLeadingMarginViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        applyMargin()
    }

    func applyMargin() {
        guard let navigationBar = navigationController?.navigationBar else { return }
        var margins = navigationBar.directionalLayoutMargins
        margins.leading = 16
        navigationBar.directionalLayoutMargins = margins
    }
}

struct SessionListRowActions {
    let retryLoad: () -> Void
    let open: (SessionSummary) -> Void
    let togglePinned: (SessionSummary) -> Void
    let archive: (SessionSummary) -> Void
    let delete: (SessionSummary) -> Void
    let rename: (SessionSummary) -> Void
    let duplicate: (SessionSummary) -> Void
    let move: (SessionSummary, String?) -> Void
    let createProject: (SessionSummary) -> Void
    let refreshProjects: () -> Void
    let export: (SessionSummary, SessionExportFormat) -> Void
}

enum SessionRowActionPolicy {
    static func offersMutationActions(for session: SessionSummary) -> Bool {
        !session.isSessionReadOnly
    }

    static func canDuplicate(_ session: SessionSummary) -> Bool {
        offersMutationActions(for: session) && !isExternalSession(session)
    }

    static func canExport(_ session: SessionSummary, isViewingCachedData: Bool) -> Bool {
        !isViewingCachedData && hasServerSessionID(session)
    }

    static func deepLinkURL(
        for session: SessionSummary,
        isViewingCachedData: Bool,
        isMutating: Bool
    ) -> URL? {
        guard !isMutating,
              canExport(session, isViewingCachedData: isViewingCachedData),
              let sessionID = session.sessionId
        else {
            return nil
        }

        return TalariaDeepLink.sessionURL(sessionID: sessionID)
    }

    private static func isExternalSession(_ session: SessionSummary) -> Bool {
        let sessionSource = normalizedSource(session.sessionSource)
        let rawSource = normalizedSource(session.rawSource) ?? normalizedSource(session.sourceTag)
        let source = sessionSource ?? rawSource

        if source == "webui" { return false }
        if sessionSource == "messaging" { return true }

        switch rawSource {
        case "weixin", "telegram", "discord", "slack", "email", "wecom", "wecom_callback", "matrix":
            return true
        default:
            return session.isCliSession == true
        }
    }

    private static func normalizedSource(_ source: String?) -> String? {
        let normalized = source?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}

enum SessionListMotion {
    static func disclosureAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .smooth(duration: 0.28, extraBounce: 0)
    }

    static func pressAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? .easeOut(duration: 0.12) : .smooth(duration: 0.18, extraBounce: 0)
    }

    static func sessionMutationAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0)
    }

    static func sessionRowTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top))
    }

    static func disclosureContentTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top))
    }
}

/// Which of the session list's optional navigation rows are shown, so a user can
/// hide the parts of the app they never use (issue #189).
struct SidebarSectionVisibility: Equatable {
    var tasks: Bool
    var kanban: Bool
    var skills: Bool
    var memory: Bool
    var insights: Bool
    var activeProfile: Bool
    var projects: Bool

    /// Show every row, primarily for previews and tests.
    static let showAll = SidebarSectionVisibility(
        tasks: true,
        kanban: true,
        skills: true,
        memory: true,
        insights: true,
        activeProfile: true,
        projects: true
    )

    /// The five plain links share one List row, so that row is dropped entirely
    /// once all of them are hidden rather than leaving an empty padded gap.
    var showsAnyUtilityLink: Bool {
        tasks || kanban || skills || memory || insights
    }
}

struct SessionSidebarUtilityRows: View {
    // Vertical gap between every utility row, matching the navigation rows so the
    // headers and subrows share one consistent rhythm now that each is its own row.
    private static let rowSpacing: CGFloat = 2

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let viewModel: SessionListViewModel
    let topPadding: CGFloat
    let automatedVisibility: AutomatedSessionVisibility
    let sectionVisibility: SidebarSectionVisibility
    @Binding var profilesAreExpanded: Bool
    @Binding var projectsAreExpanded: Bool
    @Binding var selectedProjectID: String?
    @Binding var projectPendingDeletion: ProjectSummary?
    @Binding var projectPendingRename: ProjectSummary?

    let openDestination: (SessionListUtilityDestination) -> Void
    let switchActiveProfile: (ProfileSummary) -> Void
    let presentProjectCreation: () -> Void

    // Each disclosure subrow is emitted as its own List row (like the session
    // rows below it). List does not animate height/transition changes inside a
    // single row, so packing the subrows into one row made expand/collapse snap
    // instantly. As real rows, List animates them folding in/out; the fold is
    // driven by a value-based .animation on the List in SessionListView, which
    // works even though the disclosure booleans are @AppStorage-backed.
    var body: some View {
        if sectionVisibility.showsAnyUtilityLink {
            utilityLinks
                .padding(.top, topPadding)
                .sessionsScreenListRow()
        }

        // In single-profile mode the server rejects switching, so the whole
        // "Active Profile" disclosure would only no-op or error — hide it (#24).
        if showsActiveProfile {
            activeProfileHeader
                .padding(.top, activeProfileTopPadding)
                .sessionsScreenListRow()

            if profilesAreExpanded {
                activeProfileOptionRows
            }
        }

        if sectionVisibility.projects {
            projectsHeader
                .padding(.top, projectsTopPadding)
                .sessionsScreenListRow()

            if projectsAreExpanded {
                projectOptionRows
            }
        }
    }

    private var showsActiveProfile: Bool {
        sectionVisibility.activeProfile && !viewModel.isSingleProfileMode
    }

    // Whichever row lands first carries the section's top padding, since #189 can
    // hide the rows above it; the rest keep the tight inter-row spacing.
    private var activeProfileTopPadding: CGFloat {
        sectionVisibility.showsAnyUtilityLink ? Self.rowSpacing : topPadding
    }

    private var projectsTopPadding: CGFloat {
        sectionVisibility.showsAnyUtilityLink || showsActiveProfile ? Self.rowSpacing : topPadding
    }

    private func disclosureSubrow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 24)
            .padding(.top, Self.rowSpacing)
            .sessionsScreenListRow()
            .transition(SessionListMotion.disclosureContentTransition(reduceMotion: reduceMotion))
    }

    private var utilityLinks: some View {
        VStack(alignment: .leading, spacing: Self.rowSpacing) {
            if sectionVisibility.tasks {
                SidebarNavButton(title: String(localized: "Tasks"), assetImage: "LucideCalendarClock") {
                    openDestination(.tasks)
                }
            }

            if sectionVisibility.kanban {
                SidebarNavButton(title: String(localized: "Kanban"), assetImage: "LucideColumns3") {
                    openDestination(.kanban)
                }
            }

            if sectionVisibility.skills {
                SidebarNavButton(title: String(localized: "Skills"), assetImage: "LucideHammer") {
                    openDestination(.skills)
                }
            }

            if sectionVisibility.memory {
                SidebarNavButton(title: String(localized: "Memory"), assetImage: "LucideBrain") {
                    openDestination(.memory)
                }
            }

            if sectionVisibility.insights {
                SidebarNavButton(title: String(localized: "Insights"), assetImage: "LucideChartColumnIncreasing") {
                    openDestination(.insights)
                }
            }
        }
        .padding(.horizontal, 24)
    }

    private var activeProfileHeader: some View {
        SidebarDisclosureButton(
            title: String(localized: "Active Profile"),
            assetImage: "LucideUserRoundCog",
            isExpanded: profilesAreExpanded,
            tint: viewModel.activeProfileErrorMessage == nil ? .primary : .orange
        ) {
            profilesAreExpanded.toggle()
        } accessory: {
            if viewModel.isLoadingActiveProfile {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 24)
        .accessibilityLabel(profilesAreExpanded ? "Collapse active profile picker" : "Expand active profile picker")
    }

    @ViewBuilder
    private var activeProfileOptionRows: some View {
        if viewModel.isLoadingActiveProfile && viewModel.profileOptions.isEmpty {
            disclosureSubrow {
                CompactStatusRow(title: String(localized: "Loading profiles..."), systemImage: "person.crop.circle")
            }
        } else if viewModel.profileOptions.isEmpty {
            disclosureSubrow {
                CompactStatusRow(
                    title: viewModel.activeProfileErrorMessage == nil ? String(localized: "No profiles") : String(localized: "Could not load profiles"),
                    systemImage: "exclamationmark.triangle"
                )
            }
        } else {
            ForEach(viewModel.profileOptions) { profile in
                let profileIsActive = isActiveProfile(profile)

                disclosureSubrow {
                    ActiveProfilePickerRow(
                        profile: profile,
                        isSelected: profileIsActive,
                        isSwitching: viewModel.isSwitchingActiveProfile
                            && viewModel.switchingActiveProfileName == profile.normalizedName
                    ) {
                        guard !profileIsActive else { return }
                        switchActiveProfile(profile)
                    }
                    .disabled(
                        viewModel.isViewingCachedData
                            || viewModel.isSwitchingActiveProfile
                            || profile.normalizedName == nil
                    )
                }
            }
        }
    }

    private var projectsHeader: some View {
        HStack(spacing: 8) {
            SidebarDisclosureButton(
                title: String(localized: "Projects"),
                assetImage: "LucideFolder",
                isExpanded: projectsAreExpanded
            ) {
                projectsAreExpanded.toggle()
            } accessory: {
                EmptyView()
            }
            .accessibilityLabel(projectsAreExpanded ? "Collapse projects" : "Expand projects")

            // Standalone "create empty project" affordance, shown only while the
            // Projects list is expanded. It is a sibling of the disclosure button
            // (not nested inside its label) so VoiceOver exposes it as its own
            // focusable control, mirroring the "All" button below. Nesting it in
            // the button's label flattened it into the parent's a11y element and
            // made it unreachable by assistive tech.
            if projectsAreExpanded {
                addProjectButton
            }

            if selectedProjectID != nil {
                HapticButton {
                    withAnimation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion)) {
                        selectedProjectID = nil
                    }
                } label: {
                    Text("All")
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        // Flat translucent fill rather than Liquid Glass: the glass
                        // elevation shadow would spill past this tightly-sized List
                        // row and get clipped by the next row's opaque background.
                        .background(.thinMaterial, in: Capsule())
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                .accessibilityLabel("Show all projects")
                .accessibilityHint("Clears the selected project filter.")
            }
        }
        .padding(.horizontal, 24)
    }

    private var addProjectButton: some View {
        HapticButton {
            presentProjectCreation()
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add project")
        .accessibilityHint("Creates a new empty project.")
    }

    @ViewBuilder
    private var projectOptionRows: some View {
        if viewModel.isLoadingProjects && viewModel.projects.isEmpty {
            disclosureSubrow {
                CompactStatusRow(title: String(localized: "Loading projects..."), systemImage: "folder")
            }
        } else if viewModel.projects.isEmpty {
            disclosureSubrow {
                CompactStatusRow(title: String(localized: "No projects"), systemImage: "folder")
            }
        } else {
            ForEach(viewModel.projects) { project in
                disclosureSubrow {
                    ProjectFilterRow(
                        project: project,
                        isSelected: selectedProjectID == project.projectId,
                        count: sessionCount(for: project),
                        isViewingCachedData: viewModel.isViewingCachedData,
                        isRenamingProject: viewModel.isRenamingProject,
                        isDeletingProject: viewModel.isDeletingProject
                    ) {
                        guard let projectID = project.projectId else { return }

                        withAnimation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion)) {
                            selectedProjectID = selectedProjectID == projectID ? nil : projectID
                        }
                    } rename: {
                        projectPendingRename = project
                    } delete: {
                        projectPendingDeletion = project
                    }
                }
            }
        }
    }

    private func isActiveProfile(_ profile: ProfileSummary) -> Bool {
        guard let profileName = profile.normalizedName else { return false }

        if let activeProfileName = viewModel.activeProfileName {
            return profileName == activeProfileName
        }

        return profile.isActive == true
    }

    private func sessionCount(for project: ProjectSummary) -> Int {
        guard let projectID = project.projectId else { return 0 }
        return viewModel.sessions.filter { session in
            session.projectId == projectID && automatedVisibility.shows(session)
        }.count
    }
}









/// Pure, testable backing model for the session-list avatar's long-press server
/// switcher (#283). Maps `AuthManager.servers` + the active server id into the
/// rows the context menu renders, deriving each row's display name the same way
/// the Settings server list does, so the menu's contents — and which server is
/// marked active — are unit-testable without standing up the view.
struct AvatarServerSwitcherModel: Equatable {
    struct Entry: Identifiable, Equatable {
        let id: String
        let account: ServerAccount
        let displayName: String
        let isActive: Bool
    }

    let entries: [Entry]

    /// The id of the entry marked active, or nil when the active id matches no
    /// configured server (a defensive transient, e.g. mid-removal).
    var activeID: String? { entries.first(where: \.isActive)?.id }

    init(servers: [ServerAccount], activeServerID: String?) {
        entries = servers.map { account in
            let hostFallback = URL(string: account.urlString)?.host ?? account.urlString
            let displayName = account.displayName.isEmpty ? hostFallback : account.displayName
            return Entry(
                id: account.id,
                account: account,
                displayName: displayName,
                isActive: account.id == activeServerID
            )
        }
    }
}

/// Long-press menu on the session-list avatar: switch the active server (the
/// active one marked + disabled, mirroring `SessionProjectMoveMenu`'s checkmark
/// idiom), plus shortcuts into #17's add-server flow and the Settings server
/// list (#283). Holds no switching logic — it calls back into the tested #17
/// `AuthManager.switchActiveServer` action and the existing navigation.

extension View {
    func sessionsScreenListRow(insets: EdgeInsets = EdgeInsets()) -> some View {
        listRowInsets(insets)
            .listRowSeparator(.hidden)
            .listRowBackground(Color(.systemBackground))
    }

    func sessionsChromeGlass<S: InsettableShape>(
        isInteractive: Bool = false,
        tint: Color? = nil,
        fallbackMaterial: Material = .ultraThinMaterial,
        in shape: S
    ) -> some View {
        adaptiveGlass(
            .regular,
            isInteractive: isInteractive,
            tint: tint,
            fallbackMaterial: fallbackMaterial,
            in: shape
        )
    }
}

/// Sheet item for a finished session export: the temp file offered to the
/// share sheet. Identity is the file URL, which is unique per export.
struct SessionExportShareItem: Identifiable {
    let fileURL: URL

    var id: String { fileURL.absoluteString }
}

/// Minimal `UIActivityViewController` wrapper — the app has no other share
/// surface and `ShareLink` can't be presented programmatically after an async
/// download finishes. Cleanup of the temp file happens in the sheet's
/// `onDismiss`, which runs after the activity UI is gone in both the
/// completed and cancelled paths.

func hasServerSessionID(_ session: SessionSummary) -> Bool {
    guard let sessionID = session.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) else {
        return false
    }

    return !sessionID.isEmpty
}

struct SessionListFloatingChatButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let isPressed = isEnabled && configuration.isPressed

        configuration.label
            .scaleEffect(reduceMotion ? 1 : (isPressed ? 0.975 : 1))
            .opacity(isPressed ? 0.96 : 1)
            .shadow(
                color: .black.opacity(isPressed ? 0.10 : 0.18),
                radius: isPressed ? 8 : 18,
                y: isPressed ? 3 : 8
            )
            .animation(SessionListMotion.pressAnimation(reduceMotion: reduceMotion), value: isPressed)
    }
}



enum AppSidebarDestination: Hashable {
    case chats
    case tasks
    case kanban
    case skills
    case memory
    case insights
    case quota(String)
    case settings
}

enum AppSidebarGesturePolicy {
    static let edgeActivationWidth: CGFloat = 28

    static func accepts(
        isPresented: Bool,
        startX: CGFloat,
        containerWidth: CGFloat,
        translation: CGSize,
        isRightToLeft: Bool
    ) -> Bool {
        guard abs(translation.width) > abs(translation.height) else { return false }
        guard !isPresented else { return true }

        return isRightToLeft
            ? startX >= containerWidth - edgeActivationWidth
            : startX <= edgeActivationWidth
    }

    static func progress(
        isPresented: Bool,
        translationWidth: CGFloat,
        revealWidth: CGFloat,
        isRightToLeft: Bool
    ) -> CGFloat {
        guard revealWidth > 0 else { return 0 }
        let direction: CGFloat = isRightToLeft ? -1 : 1
        let currentOffset = isPresented ? revealWidth : 0
        return min(max((currentOffset + translationWidth * direction) / revealWidth, 0), 1)
    }
}






struct SidebarSubrowSelectionStyle: ViewModifier {
    let isSelected: Bool

    func body(content: Content) -> some View {
        content
            .padding(.leading, 18)
            .padding(.trailing, 10)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.opacity(0.10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(Color.accentColor.opacity(0.20), lineWidth: 1)
                        }
                }
            }
    }
}

extension View {
    func sidebarSubrowSelectionStyle(isSelected: Bool) -> some View {
        modifier(SidebarSubrowSelectionStyle(isSelected: isSelected))
    }
}



extension Color {
    init?(hexString: String?) {
        guard let hexString else { return nil }

        var trimmed = hexString
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("#") {
            trimmed.removeFirst()
        }

        let expanded: String
        switch trimmed.count {
        case 3:
            expanded = trimmed.map { "\($0)\($0)" }.joined()
        case 6:
            expanded = trimmed
        default:
            return nil
        }

        guard let value = UInt64(expanded, radix: 16) else { return nil }

        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}




struct SessionRowSkeletonConfiguration: Identifiable {
    let id: String
    let title: String
    let messageCount: String
    let workspace: String
    let relativeDate: String

    static let loadingRows: [SessionRowSkeletonConfiguration] = [
        SessionRowSkeletonConfiguration(
            id: "recent-build",
            title: "Review latest mobile build notes",
            messageCount: "12 messages",
            workspace: "talaria",
            relativeDate: "5m"
        ),
        SessionRowSkeletonConfiguration(
            id: "polish-pass",
            title: "Plan the next polish pass",
            messageCount: "8 messages",
            workspace: "design",
            relativeDate: "1h"
        ),
        SessionRowSkeletonConfiguration(
            id: "streaming-check",
            title: "Streaming behavior investigation",
            messageCount: "24 messages",
            workspace: "webui",
            relativeDate: "3h"
        ),
        SessionRowSkeletonConfiguration(
            id: "testflight",
            title: "TestFlight validation checklist",
            messageCount: "6 messages",
            workspace: "release",
            relativeDate: "1d"
        ),
        SessionRowSkeletonConfiguration(
            id: "followup",
            title: "Follow-up implementation details",
            messageCount: "17 messages",
            workspace: "notes",
            relativeDate: "2d"
        )
    ]
}
