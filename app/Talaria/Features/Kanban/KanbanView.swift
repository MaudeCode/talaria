import SwiftUI
import TalariaKit

struct KanbanView: View {
    @State private var model: KanbanFeatureState

    init(server: URL, onAPIError: @escaping (Error) -> Void) {
        _model = State(
            initialValue: KanbanFeatureState(
                server: server,
                onAPIError: onAPIError
            )
        )
    }

    var body: some View {
        KanbanStatusFocusView(model: model)
            .task {
                await model.load()
            }
    }
}
