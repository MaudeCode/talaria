import SwiftUI
import TalariaKit

struct GroupedSessionsDisclosure: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sessionRowStyle) private var rowStyle
    let title: String
    let assetImage: String?
    let systemImage: String?
    let expandAccessibilityLabel: String
    let collapseAccessibilityLabel: String
    let viewModel: SessionListViewModel
    let sessions: [SessionSummary]
    let totalCount: Int
    /// More sessions exist than the server lists, so the count reads "200+" (TAL-482).
    var countIsPartial = false
    let isSearchActive: Bool
    let searchText: String
    let selectedSessionID: String?
    @Binding var userIsExpanded: Bool
    let actions: SessionListRowActions
    let viewAll: () -> Void
    var showsHeading = true

    private var isExpanded: Bool { isSearchActive || userIsExpanded }
    private var displayedSessions: [SessionSummary] {
        isSearchActive ? sessions : Array(sessions.prefix(5))
    }

    var body: some View {
        if showsHeading {
            header
                .accessibilityLabel(
                    isSearchActive
                        ? title
                        : isExpanded
                            ? collapseAccessibilityLabel
                            : expandAccessibilityLabel
                )
        }

        if isExpanded {
            ForEach(displayedSessions) { session in
                SessionInteractiveRow(
                    viewModel: viewModel,
                    session: session,
                    selectedSessionID: selectedSessionID,
                    actions: actions,
                    searchText: searchText
                )
                .transition(SessionListMotion.disclosureContentTransition(reduceMotion: reduceMotion))
            }

            if !isSearchActive && sessions.count > 5 {
                HapticButton(action: viewAll) {
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .frame(width: 24)
                        Text("View all")
                            .font(.subheadline.weight(.medium))
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .sessionsScreenListRow()
                .transition(SessionListMotion.disclosureContentTransition(reduceMotion: reduceMotion))
            }
        }
    }
    private func toggle() {
        guard !isSearchActive else { return }
        userIsExpanded.toggle()
    }

    @ViewBuilder
    private var header: some View {
        if rowStyle == .sidebar {
            SidebarSectionHeader(title: title, isCompact: true, toggle: toggle) {
                Text(verbatim: countIsPartial ? "\(totalCount.formatted())+" : totalCount.formatted())
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                SidebarDisclosureChevron(isExpanded: isExpanded)
            }
        } else {
            SidebarDisclosureButton(
                title: title,
                assetImage: assetImage,
                systemImage: systemImage,
                isExpanded: isExpanded,
                action: toggle
            ) {
                Text(verbatim: countIsPartial ? "\(totalCount.formatted())+" : totalCount.formatted())
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(.thinMaterial, in: Capsule())
            }
            .padding(.horizontal, 24)
            .padding(.top, isSearchActive ? 16 : 12)
            .sessionsScreenListRow()
        }
    }

}
