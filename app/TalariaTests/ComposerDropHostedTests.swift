import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import Talaria

/// Drops onto the composer from the app beside it (TAL-1461): text, links, images and files, delivered the way UIKit
/// delivers a drop session, to the drop interaction on the view under the drop point or its nearest ancestor.
@MainActor
final class ComposerDropHostedTests: XCTestCase {
    func testDropsLandAsDraftTextAndAttachmentsOnTheDuoInnerDisplay() async throws {
        try await assertDropsLand(size: HostedSize.duoInnerLandscape)
    }

    func testDropsLandAsDraftTextAndAttachmentsOnPad() async throws {
        try await assertDropsLand(size: HostedSize.padLandscape)
    }

    func testAMixedDropHandlesEveryItemInOrder() async throws {
        let window = try await hostFixtureChat(size: HostedSize.duoInnerLandscape)
        try await typeIntoComposer("Mixed:", in: window)
        let file = try temporaryFile(named: "mixed-notes.txt")

        let operation = try await drop([
            textProvider(" first"),
            imageProvider(named: "mixed-photo.png"),
            urlProvider("https://example.com/mixed"),
            fileURLProvider(file)
        ], in: window)

        XCTAssertEqual(operation, .copy)
        let landed = await awaitCondition { self.composerDraftText(in: window) == "Mixed: firsthttps://example.com/mixed " }
        XCTAssertTrue(landed, "Draft was \(String(describing: composerDraftText(in: window)))")
        _ = try await requireElement(in: window, label: "Remove attachment mixed-photo.png", "The dropped image was not staged")
        _ = try await requireElement(in: window, label: "Remove attachment mixed-notes.txt", "The dropped file was not staged")
    }

    func testAReadOnlyComposerRefusesADropAndKeepsItsDraft() async throws {
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerChatBatchArgument], size: HostedSize.duoInnerLandscape)
        _ = try await requireElement(in: window, label: "Continue this chat in its native CLI.")
        let draft = composerDraftText(in: window)

        let operation = try await drop([textProvider("Refused text"), imageProvider(named: "refused.png")], in: window)

        XCTAssertNotEqual(operation, .copy, "A read-only composer accepted a drop")
        settle(0.3)
        XCTAssertEqual(composerDraftText(in: window), draft)
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "refused.png").isEmpty)
    }

    private func assertDropsLand(size: CGSize) async throws {
        let window = try await hostFixtureChat(size: size)
        try await typeIntoComposer("Hello world", in: window)
        let editor = try XCTUnwrap(window.firstView(ofType: ComposerTextView.PastingTextView.self))
        editor.selectedRange = NSRange(location: 6, length: 0)

        // Text lands at the caret.
        var operation = try await drop(
            [textProvider("dropped ")],
            in: window,
            hoverScreenshot: "composer-drop-hover-\(Int(size.width))x\(Int(size.height))"
        )
        XCTAssertEqual(operation, .copy)
        var landed = await awaitCondition { self.composerDraftText(in: window) == "Hello dropped world" }
        XCTAssertTrue(landed, "Text draft was \(String(describing: composerDraftText(in: window)))")

        // A link lands as its address and a space.
        editor.selectedRange = NSRange(location: (editor.text as NSString).length, length: 0)
        operation = try await drop([urlProvider("https://example.com/page")], in: window)
        XCTAssertEqual(operation, .copy)
        landed = await awaitCondition { self.composerDraftText(in: window) == "Hello dropped worldhttps://example.com/page " }
        XCTAssertTrue(landed, "Link draft was \(String(describing: composerDraftText(in: window)))")

        // An image is staged like a pasted one.
        operation = try await drop([imageProvider(named: "dropped-photo.png")], in: window)
        XCTAssertEqual(operation, .copy)
        let photo = try await requireElement(in: window, label: "Remove attachment dropped-photo.png", "The dropped image was not staged")

        // A file URL is staged like an imported file, dropped on the photo strip above the card.
        operation = try await drop(
            [fileURLProvider(try temporaryFile(named: "dropped-notes.txt"))],
            in: window,
            at: CGPoint(x: photo.accessibilityFrame.midX, y: photo.accessibilityFrame.midY)
        )
        XCTAssertEqual(operation, .copy)
        _ = try await requireElement(in: window, label: "Remove attachment dropped-notes.txt", "The dropped file was not staged")

        // Files hands over the file itself rather than its URL, so text contents still make an attachment.
        operation = try await drop([try filesProvider(try temporaryFile(named: "dropped-report.txt"))], in: window)
        XCTAssertEqual(operation, .copy)
        _ = try await requireElement(in: window, label: "Remove attachment dropped-report.txt", "The file from Files was not staged")

        XCTAssertEqual(composerDraftText(in: window), "Hello dropped worldhttps://example.com/page ", "An attachment drop changed the draft")
        settle(1)
        attachHostedScreenshot(window, name: "composer-drops-\(Int(size.width))x\(Int(size.height))")
    }

    // MARK: - Drop session

    /// Delivers `providers` as one drop at `point`, or the composer's centre, and returns the operation its
    /// destination proposed. `hoverScreenshot` names an image of the window while the drop hovers.
    private func drop(
        _ providers: [NSItemProvider],
        in window: UIWindow,
        at point: CGPoint? = nil,
        hoverScreenshot: String? = nil
    ) async throws -> UIDropOperation {
        // A staged attachment's strip slides in above the card; aim once it has.
        settle(0.3)
        let point = try point ?? composerCentre(in: window)
        let session = HostedDropSession(providers: providers, point: point, window: window)
        var view = window.hitTest(point, with: nil)
        while let candidate = view {
            for case let interaction as UIDropInteraction in candidate.interactions {
                guard let delegate = interaction.delegate,
                      delegate.dropInteraction?(interaction, canHandle: session) ?? true else { continue }
                delegate.dropInteraction?(interaction, sessionDidEnter: session)
                settle()
                let operation = delegate.dropInteraction?(interaction, sessionDidUpdate: session).operation ?? .cancel
                settle()
                if let hoverScreenshot {
                    settle(0.3)
                    attachHostedScreenshot(window, name: hoverScreenshot)
                }
                if operation == .copy || operation == .move {
                    delegate.dropInteraction?(interaction, performDrop: session)
                } else {
                    delegate.dropInteraction?(interaction, sessionDidExit: session)
                }
                delegate.dropInteraction?(interaction, sessionDidEnd: session)
                settle()
                return operation
            }
            view = candidate.superview
        }
        return .cancel
    }

    private func composerCentre(in window: UIWindow) throws -> CGPoint {
        if let editor = window.firstView(ofType: ComposerTextView.PastingTextView.self) {
            return editor.convert(CGPoint(x: editor.bounds.midX, y: editor.bounds.midY), to: window)
        }
        let shell = try XCTUnwrap(
            HostedAccessibility.element(in: window, label: "Message")
                ?? HostedAccessibility.element(in: window, label: "Composer options"),
            "The chat has no composer"
        )
        return CGPoint(x: shell.accessibilityFrame.midX, y: shell.accessibilityFrame.midY)
    }

    private func textProvider(_ text: String) -> NSItemProvider {
        NSItemProvider(object: text as NSString)
    }

    private func urlProvider(_ address: String) -> NSItemProvider {
        NSItemProvider(object: URL(string: address)! as NSURL)
    }

    private func imageProvider(named name: String) -> NSItemProvider {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let provider = NSItemProvider(item: image.pngData()! as NSData, typeIdentifier: UTType.png.identifier)
        provider.suggestedName = name
        return provider
    }

    private func fileURLProvider(_ url: URL) -> NSItemProvider {
        NSItemProvider(item: url as NSURL, typeIdentifier: UTType.fileURL.identifier)
    }

    /// A file as Files hands it over: its contents under its name.
    private func filesProvider(_ url: URL) throws -> NSItemProvider {
        let provider = try XCTUnwrap(NSItemProvider(contentsOf: url))
        provider.suggestedName = url.lastPathComponent
        return provider
    }

    private func temporaryFile(named name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(name)
        try Data("Fixture drop \(name)\n".utf8).write(to: url)
        return url
    }
}

/// An external drop session at one point of a hosted window: what UIKit hands a drop interaction's delegate.
private final class HostedDropSession: NSObject, UIDropSession {
    let items: [UIDragItem]
    private let point: CGPoint
    private weak var window: UIWindow?
    let progress = Progress(totalUnitCount: 1)

    init(providers: [NSItemProvider], point: CGPoint, window: UIWindow) {
        items = providers.map(UIDragItem.init(itemProvider:))
        self.point = point
        self.window = window
    }

    var localDragSession: UIDragSession? { nil }
    var progressIndicatorStyle: UIDropSessionProgressIndicatorStyle = .none
    var allowsMoveOperation: Bool { false }
    var isRestrictedToDraggingApplication: Bool { false }

    func location(in view: UIView) -> CGPoint {
        view.convert(point, from: window)
    }

    func hasItemsConforming(toTypeIdentifiers typeIdentifiers: [String]) -> Bool {
        items.contains { item in typeIdentifiers.contains { item.itemProvider.hasItemConformingToTypeIdentifier($0) } }
    }

    func canLoadObjects(ofClass aClass: NSItemProviderReading.Type) -> Bool {
        items.contains { $0.itemProvider.canLoadObject(ofClass: aClass) }
    }

    func loadObjects(ofClass aClass: NSItemProviderReading.Type, completion: @escaping ([NSItemProviderReading]) -> Void) -> Progress {
        let group = DispatchGroup()
        var objects: [NSItemProviderReading?] = Array(repeating: nil, count: items.count)
        for (index, item) in items.enumerated() where item.itemProvider.canLoadObject(ofClass: aClass) {
            group.enter()
            _ = item.itemProvider.loadObject(ofClass: aClass) { object, _ in
                DispatchQueue.main.async {
                    objects[index] = object
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) { completion(objects.compactMap { $0 }) }
        return progress
    }
}

