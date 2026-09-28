import SwiftUI
import TalariaKit

/// The task editor's multi-select skills picker. Each toggle writes straight
/// to the draft, so the sheet stays open while rows are toggled.
///
/// A selected skill the server no longer lists still gets a row, so a saved
/// selection is always visible and removable. Upstream accepts `skills`
/// unvalidated, so a name can always be added by hand, including while the
/// skill list is unavailable.
struct CronJobSkillsPickerSheet: View {
    let skills: [SkillSummary]
    let selection: [String]
    let isLoading: Bool
    let errorMessage: String?
    let onRetry: () -> Void
    let onToggle: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var customName = ""

    var body: some View {
        NavigationStack {
            List {
                if skills.isEmpty, isLoading {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Loading skills...")
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if skills.isEmpty, let errorMessage {
                    Section {
                        Label("Could Not Load Skills", systemImage: "exclamationmark.triangle")
                        Text(verbatim: errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Try Again", action: onRetry)
                    }
                }

                Section {
                    ForEach(listedSkills, id: \.id) { skill in
                        skillRow(skill)
                    }
                }

                Section("Custom") {
                    HStack {
                        TextField("Name", text: $customName)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(addCustomSkill)

                        Button("Add", action: addCustomSkill)
                            .disabled(trimmedCustomName.isEmpty || selection.contains(trimmedCustomName))
                    }
                }
            }
            .searchable(text: $searchText)
            .navigationTitle("Skills")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .adaptiveFormPresentation()
    }

    private var trimmedCustomName: String {
        customName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func addCustomSkill() {
        let name = trimmedCustomName
        guard !name.isEmpty, !selection.contains(name) else { return }
        onToggle(name)
        customName = ""
    }

    private var listedSkills: [SkillSummary] {
        Self.filteredSkills(
            Self.skillsIncludingSelection(skills, selection: selection),
            query: searchText
        )
    }

    /// The server's list, plus a row for every selected skill it does not
    /// offer, so a saved selection is always visible and always removable.
    static func skillsIncludingSelection(
        _ skills: [SkillSummary],
        selection: [String]
    ) -> [SkillSummary] {
        let known = Set(skills.compactMap(\.name))
        let missing = selection.filter { !known.contains($0) }
        return missing.map { SkillSummary(name: $0, category: nil, description: nil, path: nil) } + skills
    }

    /// A skill is findable by every string its row shows.
    static func filteredSkills(_ skills: [SkillSummary], query: String) -> [SkillSummary] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return skills }

        return skills.filter { skill in
            (skill.name?.localizedCaseInsensitiveContains(query) ?? false)
                || (skill.category?.localizedCaseInsensitiveContains(query) ?? false)
                || (skill.description?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    private func skillRow(_ skill: SkillSummary) -> some View {
        let name = skill.name ?? ""
        let isSelected = selection.contains(name)
        let details = skill.description?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? skill.category?.trimmingCharacters(in: .whitespacesAndNewlines)

        return Button {
            onToggle(name)
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: name)
                        .foregroundStyle(.primary)

                    if let details, !details.isEmpty {
                        Text(verbatim: details)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 0)

                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(name.isEmpty)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
