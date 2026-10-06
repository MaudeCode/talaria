import SwiftUI
import TalariaKit

struct SkillCategorySection: View {
    let category: String
    let skills: [SkillSummary]
    let server: URL
    let togglingSkillNames: Set<String>
    let onToggleSkill: (SkillSummary, Bool) async -> Void
    let onAPIError: (Error) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(category)
                .textCase(.uppercase)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(skills.enumerated()), id: \.offset) { index, skill in
                    let onToggle: ((Bool) -> Void)? = canToggle(skill) ? { enabled in
                        Task { await onToggleSkill(skill, enabled) }
                    } : nil
                    NavigationLink {
                        SkillDetailView(
                            skill: skill,
                            server: server,
                            onAPIError: onAPIError
                        )
                    } label: {
                        SkillRow(skill: skill, isToggling: isToggling(skill), onToggle: onToggle)
                    }
                    .buttonStyle(.plain)
                    // The switch sits over the link, where it lines up with the slot SkillRow
                    // keeps for it, rather than inside the link's label: there the link could
                    // take a tap on the switch and open the skill instead (TAL-647).
                    .overlay(alignment: .topTrailing) {
                        if let onToggle {
                            HStack(alignment: .top) {
                                SkillToggle(skill: skill, isToggling: isToggling(skill), onToggle: onToggle)
                                SkillRow.chevron.hidden()
                            }
                            .padding(.vertical, 10)
                        }
                    }
                    .contextMenu {
                        if canToggle(skill) {
                            let isDisabled = skill.disabled == true
                            Button {
                                Task { await onToggleSkill(skill, isDisabled) }
                            } label: {
                                Label(isDisabled ? "Enable" : "Disable", systemImage: isDisabled ? "checkmark.circle" : "pause.circle")
                            }
                            .disabled(isToggling(skill))
                        }
                    }

                    if index < skills.count - 1 {
                        Divider()
                    }
                }
            }
        }
    }

    private func canToggle(_ skill: SkillSummary) -> Bool {
        guard skill.disabled != nil else { return false }
        let name = skill.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return !(name ?? "").isEmpty
    }

    private func isToggling(_ skill: SkillSummary) -> Bool {
        guard let name = skill.name?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return togglingSkillNames.contains(name)
    }
}
