import Observation
import SwiftUI

/// Device-local state outlives a row's expensive, recyclable content.
@MainActor
@Observable
final class ChatTranscriptRowState {
    fileprivate var values: [String: Any] = [:]
}

private struct ChatTranscriptRowStateKey: EnvironmentKey {
    static let defaultValue: ChatTranscriptRowState? = nil
}

extension EnvironmentValues {
    var chatTranscriptRowState: ChatTranscriptRowState? {
        get { self[ChatTranscriptRowStateKey.self] }
        set { self[ChatTranscriptRowStateKey.self] = newValue }
    }
}

/// Extends State with the row's retained storage; standalone cards keep normal State semantics.
@MainActor
@propertyWrapper
struct ChatRetainedState<Value>: DynamicProperty {
    @Environment(\.chatTranscriptRowState) private var store
    @State private var localValue: Value
    private let key: String

    init(wrappedValue: Value, _ key: String) {
        self.key = key
        _localValue = State(initialValue: wrappedValue)
    }

    var wrappedValue: Value {
        get { (store?.values[key] as? Value) ?? localValue }
        nonmutating set {
            if let store { store.values[key] = newValue as Any }
            else { localValue = newValue }
        }
    }

    var projectedValue: Binding<Value> {
        Binding(get: { wrappedValue }, set: { wrappedValue = $0 })
    }
}

/// A stable, lightweight scroll target. Only nearby rows build rich content;
/// absent content occupies its last measured height (an estimate after edits
/// or a width/font change). A realized row always measures its current content.
struct ChatTranscriptRow<Content: View>: View {
    let rowID: String
    let positionController: ChatScrollPositionController
    let cache: ChatTranscriptRowCache
    let priority: Int
    let isPinned: Bool
    let isTail: Bool
    let allowsRealization: Bool
    let willRealize: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var isAdmitted = false

    private var realizesContent: Bool {
        isPinned || isTail || (allowsRealization && isAdmitted)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if realizesContent {
                content()
                    .environment(\.chatTranscriptRowState, cache.state(for: rowID))
                    .onGeometryChange(for: CGFloat.self, of: \.size.height) { height in
                        cache.record(height: height, for: rowID)
                    }
            } else {
                Color.clear.frame(height: cache.height(for: rowID))
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityHidden(!realizesContent)
        .onChange(of: priority) { requestRealization() }
        .onChange(of: allowsRealization) { requestRealization() }
        .onChange(of: isPinned) { requestRealization() }
        .onAppear { requestRealization() }
        .onDisappear {
            positionController.cancelRowRealization(id: rowID)
        }
    }

    private func requestRealization() {
        if isPinned || isTail {
            positionController.cancelRowRealization(id: rowID)
            isAdmitted = true
        } else if allowsRealization, !isAdmitted {
            positionController.enqueueRowRealization(id: rowID, priority: priority) {
                willRealize()
                isAdmitted = true
            }
        } else if !allowsRealization {
            positionController.cancelRowRealization(id: rowID)
        }
    }
}

/// Retains row-local state and exact offscreen extents outside removable views.
/// Extends ChatTranscriptRow's content recycling to its lightweight layout nodes.
@MainActor
@Observable
final class ChatTranscriptRowCache {
    enum Element: Identifiable {
        case row(Int, String)
        case gap(String, String, CGFloat)

        var id: String {
            switch self {
            case let .row(_, id): id
            case let .gap(first, last, _): "transcript-gap:\(first.utf8.count):\(first)\(last)"
            }
        }
    }

    @ObservationIgnored private var states: [String: ChatTranscriptRowState] = [:]
    @ObservationIgnored private var heights: [String: CGFloat] = [:]
    @ObservationIgnored private var orderedIDs: [String] = []
    @ObservationIgnored private var prefix: [CGFloat] = [0]
    @ObservationIgnored private var cachedRevision = -1
    @ObservationIgnored private var cachedSpacing: CGFloat = 0
    @ObservationIgnored private(set) var mountedIDs = Set<String>()
    private var revision = 0
    var layoutRevision: Int { revision }

    func state(for id: String) -> ChatTranscriptRowState {
        if let state = states[id] { return state }
        let state = ChatTranscriptRowState()
        states[id] = state
        return state
    }

    func height(for id: String) -> CGFloat { heights[id] ?? 200 }

    func containsRow(_ id: String) -> Bool { orderedIDs.contains(id) }

    func realizationPriority(at index: Int, top: CGFloat, viewportHeight: CGFloat) -> Int {
        let distance = max(0, max(top - (prefix[index + 1] - cachedSpacing),
                                  prefix[index] - top - viewportHeight))
        return distance.isFinite ? Int(ceil(distance / 200)) : 0
    }

    func record(height: CGFloat, for id: String) {
        guard height.isFinite, height >= 0, heights[id] != height else { return }
        heights[id] = height
        revision += 1
    }

    func elements(ids: [String], top: CGFloat, viewportHeight: CGFloat, spacing: CGFloat,
                  pinned: Set<String>, freezesWindow: Bool) -> [Element] {
        if ids != orderedIDs || cachedRevision != revision || cachedSpacing != spacing {
            orderedIDs = ids
            cachedRevision = revision
            cachedSpacing = spacing
            prefix = [0]
            for id in ids { prefix.append(prefix.last! + height(for: id) + spacing) }
        }
        guard !ids.isEmpty else {
            mountedIDs.removeAll()
            return []
        }
        var selected = Set(ids.indices.filter { pinned.contains(ids[$0]) })
        selected.insert(ids.count - 1)
        if !freezesWindow {
            let margin = max(0, viewportHeight) * 2
            // Prefix extents are rebuilt only when order or measured heights change.
            var low = 0
            var high = ids.count
            while low < high {
                let mid = (low + high) / 2
                if prefix[mid + 1] - spacing < top - margin { low = mid + 1 }
                else { high = mid }
            }
            var index = low
            while index < ids.count, prefix[index] <= top + viewportHeight + margin {
                selected.insert(index)
                index += 1
            }
        }
        mountedIDs = Set(selected.map { ids[$0] })
        var result: [Element] = []
        var start = 0
        for index in selected.sorted() {
            if start < index {
                result.append(.gap(ids[start], ids[index - 1], prefix[index] - prefix[start] - spacing))
            }
            result.append(.row(index, ids[index]))
            start = index + 1
        }
        return result
    }
}
