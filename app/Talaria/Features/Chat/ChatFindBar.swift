import SwiftUI
import TalariaKit

@MainActor
@Observable
final class ChatFindPresentation {
    let bookmark: ChatScrollPositionController.ReadingBookmark?
    var query = ""
    private(set) var index = 0
    private(set) var selection = UUID()
    private(set) var response: SessionFindResponse?
    private(set) var failed = false

    init(bookmark: ChatScrollPositionController.ReadingBookmark?) {
        self.bookmark = bookmark
    }

    var match: SessionFindResponse.Match? {
        guard let matches = response?.matches, matches.indices.contains(index) else { return nil }
        return matches[index]
    }

    func search(client: APIClient, sessionID: String) async {
        let query = query
        response = nil
        failed = false
        index = 0
        selection = UUID()
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            let response = try await client.findInSession(id: sessionID, query: query)
            guard !Task.isCancelled, self.query == query, response.sessionId == sessionID else { return }
            self.response = response
            selection = UUID()
        } catch {
            guard !Task.isCancelled, !APIError.isCancellation(error), self.query == query else { return }
            failed = true
        }
    }

    func move(by step: Int) {
        guard let count = response?.matches.count, count > 0 else { return }
        index = (index + step + count) % count
        selection = UUID()
    }
}

struct ChatFindBar: View {
    @Bindable var find: ChatFindPresentation
    let client: APIClient
    let sessionID: String
    let dismiss: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicType
    @FocusState private var isFocused: Bool

    var body: some View {
        let layout = dynamicType.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 0)) : AnyLayout(HStackLayout(spacing: 4))
        layout {
            TextField("Find in Chat", text: $find.query)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .onSubmit { find.move(by: 1) }
                .focused($isFocused)
                .padding(.leading, 6)
                .frame(minHeight: 44)
                .accessibilityIdentifier("chat-find-query")
            HStack(spacing: 0) {
                if let response = find.response, response.count > 0 {
                    let total = response.truncated ? "\(response.count.formatted())+" : response.count.formatted()
                    Text("\((find.index + 1).formatted()) of \(total)")
                        .monospacedDigit()
                        .fixedSize()
                        .accessibilityIdentifier("chat-find-count")
                } else if find.failed {
                    Text("Could Not Search")
                } else if find.response != nil {
                    Text("No matches")
                }
                findButton("chevron.up", label: "Previous Match") { find.move(by: -1) }
                    .disabled(find.match == nil)
                findButton("chevron.down", label: "Next Match") { find.move(by: 1) }
                    .disabled(find.match == nil)
                findButton("xmark", label: "Done", action: dismiss)
            }
            .font(.caption)
        }
        .statusChipChrome()
        .onAppear { isFocused = true }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .task(id: find.query) { await find.search(client: client, sessionID: sessionID) }
    }

    private func findButton(_ symbol: String, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
                .labelStyle(.iconOnly)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.chatTactile(.icon))
        .help(Text(label))
    }
}
