import SwiftUI
import TalariaKit

struct ToolActivityGroupView: View {
    let group: ToolCallGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(group.toolCalls) { toolCall in
                ToolCallCardView(toolCall: toolCall)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}
