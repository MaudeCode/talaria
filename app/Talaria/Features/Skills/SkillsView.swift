import SwiftUI
import TalariaKit

/// The skill list. A row selects its skill, which `SkillDetailView` shows beside the list or
/// pushed over it (TAL-643).
struct SkillsView: View {
    let viewModel: SkillsViewModel
    @Binding var selection: SectionItem?
    let onAPIError: (Error) -> Void

    @State private var searchText = ""

    var body: some View {
        content
            .adaptiveReadableScrollContent(maxWidth: AdaptiveReadableContentWidth.secondaryDestination)
            .navigationTitle("Skills")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    RefreshToolbarButton(isLoading: viewModel.isLoading) {
                        Task { await loadSkills() }
                    }
                }
            }
            .task {
                await loadSkills()
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                await loadSkills()
            }
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search skills...")
    }

    private var filteredGroups: [(category: String, skills: [SkillSummary])] {
        viewModel.filteredGroupedSkills(searchText: searchText)
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.skills.isEmpty {
            ProgressView("Loading skills...")
        } else if let errorMessage = viewModel.errorMessage, viewModel.skills.isEmpty {
            ContentUnavailableView {
                Label("Could Not Load Skills", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await loadSkills() }
                }
            }
        } else if viewModel.skills.isEmpty {
            ContentUnavailableView {
                Label("No Skills", systemImage: "hammer")
            } description: {
                Text("Skills from the Hermes server will appear here.")
            }
        } else if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && filteredGroups.isEmpty {
            ContentUnavailableView {
                Label("No Results", systemImage: "magnifyingglass")
            } description: {
                Text("No skills match \"\(searchText)\".")
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    ForEach(filteredGroups, id: \.category) { group in
                        SkillCategorySection(
                            category: group.category,
                            skills: group.skills,
                            selection: $selection,
                            togglingSkillNames: viewModel.togglingSkillNames,
                            onToggleSkill: { skill, enabled in
                                await toggle(skill: skill, enabled: enabled)
                            }
                        )
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable {
                await loadSkills()
            }
            .background(Color(.systemBackground))
        }
    }

    private func loadSkills() async {
        await viewModel.load()
        if let error = viewModel.lastError {
            onAPIError(error)
        }
    }

    private func toggle(skill: SkillSummary, enabled: Bool) async {
        await viewModel.setSkill(skill, enabled: enabled)
        if let error = viewModel.lastError {
            onAPIError(error)
        }
    }
}






extension String: @retroactive Identifiable {
    public var id: String { self }
}
