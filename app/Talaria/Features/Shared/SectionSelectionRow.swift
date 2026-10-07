import SwiftUI
import TalariaKit

/// A section-list row that selects its item. The item's page shows beside the list at regular
/// width and is pushed over it at compact width (TAL-643).
struct SectionSelectionRow<Label: View>: View {
    let item: SectionItem
    @Binding var selection: SectionItem?
    @ViewBuilder let label: Label

    var body: some View {
        Button {
            selection = item
        } label: {
            HStack(spacing: 8) {
                label
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .listRowBackground(isSelected ? Color.accentColor.opacity(0.12) : nil)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var isSelected: Bool {
        selection == item
    }
}

extension View {
    /// The selected-row tint of the custom lists (chats, skills), with the trait VoiceOver reads.
    func selectedRowBackground(_ isSelected: Bool) -> some View {
        background(
            isSelected ? Color.accentColor.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
