import SwiftUI

/// An action the chat hands its transcript through the environment: one reference per placement whose `handler` is
/// replaced in place on every pass. SwiftUI cannot compare closures, so publishing a new closure on every pass would
/// re-run every reader, settled rows included (TAL-852). Nothing observes `handler`; a call runs the latest one.
public final class ChatEnvironmentAction<Input, Output> {
    public var handler: (Input) -> Output

    public init(_ handler: @escaping (Input) -> Output) {
        self.handler = handler
    }

    public func callAsFunction(_ input: Input) -> Output {
        handler(input)
    }
}

extension ChatEnvironmentAction where Input == Void {
    public func callAsFunction() -> Output {
        handler(())
    }
}

extension View {
    /// Publishes `perform` at `key`, keeping the same action instance below this view across passes.
    public func chatEnvironmentAction<Input, Output>(
        _ key: WritableKeyPath<EnvironmentValues, ChatEnvironmentAction<Input, Output>>,
        perform: @escaping (Input) -> Output
    ) -> some View {
        modifier(ChatEnvironmentActionModifier(key: key, wrap: { $0 }, perform: perform))
    }

    /// Publishes `perform` at an optional `key`, whose absence tells readers the chat offers no such action.
    public func chatEnvironmentAction<Input, Output>(
        _ key: WritableKeyPath<EnvironmentValues, ChatEnvironmentAction<Input, Output>?>,
        perform: @escaping (Input) -> Output
    ) -> some View {
        modifier(ChatEnvironmentActionModifier(key: key, wrap: { $0 }, perform: perform))
    }
}

private struct ChatEnvironmentActionModifier<Input, Output, Value>: ViewModifier {
    @State private var action: ChatEnvironmentAction<Input, Output>
    let key: WritableKeyPath<EnvironmentValues, Value>
    let wrap: (ChatEnvironmentAction<Input, Output>) -> Value
    let perform: (Input) -> Output

    init(key: WritableKeyPath<EnvironmentValues, Value>, wrap: @escaping (ChatEnvironmentAction<Input, Output>) -> Value,
         perform: @escaping (Input) -> Output) {
        _action = State(initialValue: ChatEnvironmentAction(perform))
        self.key = key
        self.wrap = wrap
        self.perform = perform
    }

    func body(content: Content) -> some View {
        action.handler = perform
        return content.environment(key, wrap(action))
    }
}
