import SwiftUI
import TalariaKit

/// The same navigation panel is used by the split column and the compact drawer.
struct AppSidebar<Sessions: View, Actions: ToolbarContent>: View {
    @Binding var searchText: String
    @Bindable var presentation: AppSidebarPresentation
    @State private var searchPull = SidebarSearchPull()
    let searchUsesBottomBar: Bool
    let isActive: Bool

    let selection: AppSection
    let sectionVisibility: SidebarSectionVisibility
    let select: (SessionListUtilityDestination) -> Void
    let sessions: (AnyView, SidebarSearchPull) -> Sessions
    @ToolbarContentBuilder let actions: (Bool) -> Actions

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if searchPull.isSearchPresented {
                    SettingsPickerSearchField(
                        text: $searchText,
                        prompt: "Search",
                        clearLabel: "Close search",
                        autofocus: true,
                        onClose: {
                            searchText = ""
                            searchPull.isSearchPresented = false
                        }
                    )
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                sessions(AnyView(destinations), searchPull)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            }
            .background(Color(.systemBackground))
            .accessibilityIdentifier("app-sidebar")
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                actions(searchPull.isSearchPresented)
                if !searchPull.isSearchPresented {
                    if #available(iOS 27.1, *) {
                        ToolbarItem(placement: searchUsesBottomBar ? .bottomBar : .topBarTrailing) {
                            SidebarSearchButton(pull: searchPull)
                        }
                        .axisBehavior(searchUsesBottomBar ? .verticalPreferred : .horizontalOnly)
                        .visibilityPriority(.high)
                    } else {
                        ToolbarItem(placement: searchUsesBottomBar ? .bottomBar : .topBarTrailing) {
                            SidebarSearchButton(pull: searchPull)
                        }
                    }
                }
            }
        }
        .onChange(of: searchPull.isSearchPresented) { searchPull.reset() }
        .onChange(of: presentation.searchRequested) { receiveSearchRequest() }
        .onChange(of: isActive, initial: true) {
            if isActive {
                receiveSearchRequest()
            } else {
                searchPull.isSearchPresented = false
                searchPull.reset()
            }
        }
        .onDisappear {
            searchPull.isSearchPresented = false
            searchPull.reset()
        }
    }

    private func receiveSearchRequest() {
        guard isActive, presentation.searchRequested else { return }
        presentation.searchRequested = false
        searchPull.isSearchPresented = true
    }

    private var destinations: some View {
        VStack(spacing: 0) {
            if sectionVisibility.tasks {
                destinationRow("Tasks", icon: "LucideCalendarClock", destination: .tasks)
            }
            if sectionVisibility.kanban {
                destinationRow("Kanban", icon: "LucideColumns3", destination: .kanban)
            }
            if sectionVisibility.skills {
                destinationRow("Skills", icon: "LucideHammer", destination: .skills)
            }
            if sectionVisibility.memory {
                destinationRow("Memory", icon: "LucideBrain", destination: .memory)
            }
            if sectionVisibility.insights {
                destinationRow("Insights", icon: "LucideChartColumnIncreasing", destination: .insights)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private func destinationRow(_ title: LocalizedStringKey, icon: String,
                                destination: SessionListUtilityDestination) -> some View {
        let selected = selection == AppSection(destination)
        return Button { select(destination) } label: {
            HStack(spacing: 12) {
                SidebarUtilityIcon(assetImage: icon, tint: selected ? .accentColor : .primary, size: 20)
                Text(title).font(.body).lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .foregroundStyle(selected ? Color.accentColor : .primary)
            .background(selected ? Color.accentColor.opacity(0.12) : .clear,
                        in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Geometry callbacks write here; only the toolbar button reads progress during a pull.
@Observable
final class SidebarSearchPull {
    var isSearchPresented = false
    private(set) var progress: CGFloat = 0
    @ObservationIgnored private var isInteracting = false

    func update(distance: CGFloat) {
        guard isInteracting, !isSearchPresented else { return }
        progress = min(max(distance / 72, 0), 1)
    }

    func phaseChanged(from oldPhase: ScrollPhase, to newPhase: ScrollPhase, reduceMotion: Bool) -> Bool {
        isInteracting = newPhase == .interacting
        guard oldPhase == .interacting, newPhase == .decelerating || newPhase == .idle else { return false }
        let opensSearch = progress >= 1
        if opensSearch || reduceMotion {
            reset()
        } else {
            withAnimation(.smooth) { reset() }
        }
        return opensSearch
    }

    func reset() {
        isInteracting = false
        progress = 0
    }
}

private struct SidebarSearchButton: View {
    let pull: SidebarSearchPull
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasVerticalBar = false

    var body: some View {
        let isArmed = pull.progress >= 1
        HapticButton(feedbackStyle: .medium) { pull.isSearchPresented = true } label: {
            Group {
                if isArmed && !hasVerticalBar {
                    Label("Search", systemImage: "magnifyingglass")
                        .labelStyle(.titleAndIcon)
                } else {
                    Image(systemName: "magnifyingglass")
                }
            }
            .font(.body)
            .frame(minWidth: 28, minHeight: 28)
            .padding(.horizontal, isArmed && !hasVerticalBar ? 10 : 4)
            .frame(minHeight: 36)
            .foregroundStyle(isArmed ? Color.white : Color.primary)
            .background(isArmed ? Color.accentColor : Color.clear, in: Capsule())
            .overlay {
                if !reduceMotion {
                    Circle()
                        .trim(from: 0, to: pull.progress)
                        .stroke(Color.accentColor, lineWidth: 2)
                        .rotationEffect(.degrees(-90))
                        .frame(width: 34, height: 34)
                        .opacity(isArmed ? 0 : 1)
                        .accessibilityHidden(true)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Search")
        .accessibilityIdentifier("sidebar-pull-search")
        .animation(reduceMotion ? nil : .smooth, value: isArmed)
        .onToolbarVerticalEdgeChange { hasVerticalBar = $0 }
    }
}
