import TalariaKit

extension StatusChip {
    /// A chat run status: the pill above the composer and the chips at the transcript tail.
    init(_ presentation: ChatActiveRunStatusPresentation) {
        self.init(label: presentation.label, accessibilityLabel: presentation.accessibilityLabel, icon: .activity)
    }
}
