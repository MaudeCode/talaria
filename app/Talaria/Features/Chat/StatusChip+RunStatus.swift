import TalariaKit

extension StatusChip {
    /// A chat run status: the pill above the composer and the chips at the transcript tail.
    init(_ presentation: ChatActiveRunStatusPresentation, agentName: String) {
        self.init(
            label: presentation.label(agentName: agentName),
            accessibilityLabel: presentation.accessibilityLabel(agentName: agentName),
            icon: .activity
        )
    }
}
