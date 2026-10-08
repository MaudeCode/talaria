import SwiftUI
import UIKit
import XCTest
@testable import Talaria

/// A menu button that appears beside the focused composer leaves its keyboard focus alone (TAL-677).
/// A send swaps the composer's controls; a button backed by a view controller was added as a child of
/// the page, and the inspector's split view controller rebuilt that column, taking the text view out of
/// the window.
@MainActor
final class ChatUIKitMenuButtonFocusTests: XCTestCase {
    private final class Model: ObservableObject {
        @Published var showsMenuButton = false
        @Published var isPushed = false
    }

    private struct FocusedField: UIViewRepresentable {
        let textView: UITextView

        func makeUIView(context: Context) -> UITextView { textView }
        func updateUIView(_ uiView: UITextView, context: Context) {}
    }

    private struct Screen: View {
        @ObservedObject var model: Model
        let textView: UITextView

        var body: some View {
            NavigationStack {
                Color.clear.navigationDestination(isPresented: $model.isPushed) {
                    VStack {
                        FocusedField(textView: textView).frame(height: 44)
                        if model.showsMenuButton {
                            ChatUIKitMenuButton {
                                Image(systemName: "plus")
                            } menu: {
                                UIMenu(children: [])
                            }
                        }
                    }
                    // The chat's files inspector wraps the page in a split view controller.
                    .inspector(isPresented: .constant(false)) { EmptyView() }
                }
            }
        }
    }

    private var window: UIWindow!

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    func testAMenuButtonAppearingBesideTheFocusedComposerKeepsItsFocus() throws {
        let model = Model()
        let textView = UITextView()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: Screen(model: model, textView: textView))
        window.makeKeyAndVisible()

        model.isPushed = true
        spinRunLoop(until: { textView.window != nil })
        XCTAssertNotNil(textView.window, "The pushed page never showed its field")
        XCTAssertTrue(textView.becomeFirstResponder())

        model.showsMenuButton = true
        // The column rebuild lands on a later render pass, so give it time to happen.
        spinRunLoop(for: 0.5)
        XCTAssertNotNil(textView.window, "Inserting a menu button took the focused field out of the window")
        XCTAssertTrue(textView.isFirstResponder, "Inserting a menu button dropped the focused field's keyboard focus")
    }

    private func spinRunLoop(for duration: TimeInterval = 5, until condition: () -> Bool = { false }) {
        let deadline = Date().addingTimeInterval(duration)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }
}
