import SwiftUI
import TalariaKit

struct SkillRow: View {
    let skill: SkillSummary
    var isToggling: Bool = false
    var onToggle: ((Bool) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                if let description {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }

                if skill.disabled == true || !tags.isEmpty {
                    HStack(spacing: 6) {
                        if skill.disabled == true {
                            Text("Disabled")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .foregroundStyle(.secondary)
                                .background(Color(.tertiarySystemFill), in: Capsule())
                        }

                        ForEach(tags, id: \.self) { tag in
                            Text(tag)
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .foregroundStyle(.secondary)
                                .background(Color(.secondarySystemFill).opacity(0.8), in: Capsule())
                        }
                    }
                }
            }
            // Only the text dims: the switch stays at full strength so it reads as the
            // control that turns a disabled skill back on.
            .opacity(skill.disabled == true ? 0.55 : 1)

            Spacer(minLength: 8)

            // Holds the switch's place only. The live switch sits over the row's NavigationLink
            // in `SkillCategorySection`; inside the link's label the link could take its taps.
            if let onToggle {
                SkillToggle(skill: skill, isToggling: isToggling, onToggle: onToggle)
                    .hidden()
            }

            Self.chevron
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if let onToggle {
                Button(skill.disabled == true ? "Enable" : "Disable") {
                    guard !isToggling else { return }
                    onToggle(skill.disabled == true)
                }
            }
        }
    }

    static var chevron: some View {
        Image(systemName: "chevron.forward")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
            .padding(.top, 12)
    }

    private var displayName: String {
        let name = skill.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else {
            return String(localized: "Unnamed Skill")
        }
        return name
    }

    private var description: String? {
        let text = skill.description?.trimmingCharacters(in: .whitespacesAndNewlines)
        return text?.isEmpty == false ? text : nil
    }

    private var tags: [String] {
        (skill.tags ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

/// A skill row's Enable/Disable switch. `SkillCategorySection` draws it over the row, outside
/// the row's NavigationLink, so a tap on the switch never opens the skill (TAL-647).
struct SkillToggle: View {
    let skill: SkillSummary
    let isToggling: Bool
    let onToggle: (Bool) -> Void

    var body: some View {
        Toggle(skill.disabled == true ? "Enable" : "Disable", isOn: Binding(
            get: { skill.disabled != true },
            set: { onToggle($0) }
        ))
        .labelsHidden()
        .toggleStyle(.switch)
        .scaleEffect(0.8, anchor: .trailing)
        .disabled(isToggling)
        .padding(.top, 6)
        .accessibilityIdentifier("skill-toggle-\(skill.name ?? "")")
    }
}
