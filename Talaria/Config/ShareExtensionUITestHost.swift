#if DEBUG
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// DEBUG-only host that pushes synthetic content into the real system share sheet, so
/// `ShareExtensionUITests` can drive the installed Talaria share extension end to end
/// (TAL-81). It overlays the normal app rather than replacing it: the extension opens
/// `talaria://share`, and that has to land on the real composer import path.
///
/// Every payload is generated in-process into a per-launch directory, so a run owns all
/// of its input and leaves nothing behind for the next one.
enum ShareExtensionUITestHost {
    static let launchArgument = "--ui-test-share-host"

    static let sharedText = "TalariaShareFixtureText"
    static let sharedURL = URL(string: "https://share.fixture.invalid/talaria")!

    static var isActive: Bool {
        ProcessInfo.processInfo.arguments.contains(launchArgument)
    }

    /// Each host launch starts from an empty share inbox and the shipping open path, so a
    /// draft one test leaves behind can never surface in the next one. Launches without
    /// the host bar keep the inbox: that is how a test reopens a draft the extension saved.
    static func resetSharedState() {
        ShareOpenFixtureMode.store(.normal)

        guard let directory = TalariaShareDraft.containerURL() else { return }
        let fileManager = FileManager.default
        for name in [
            TalariaShareDraft.inboxDirectoryName,
            TalariaShareDraft.pendingDraftFileName,
            TalariaShareDraft.pendingAttachmentsDirectoryName
        ] {
            try? fileManager.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    /// Fresh per launch: a leftover 25 MB fixture file must never outlive its test.
    static let payloadDirectory: URL = {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("share-extension-ui-test-host", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()
}

enum ShareExtensionUITestPayload: String, CaseIterable, Identifiable {
    case text
    case url
    case attachments
    case unsupported
    case oversizedFile
    case oversizedTotal

    var id: String { rawValue }

    /// Short on purpose: every button has to stay on screen and hittable at any size.
    var title: String {
        switch self {
        case .text: "Text"
        case .url: "URL"
        case .attachments: "Files"
        case .unsupported: "Unsup"
        case .oversizedFile: "Big"
        case .oversizedTotal: "Big2"
        }
    }

    var accessibilityIdentifier: String { "share-host-\(rawValue)" }

    /// The item set handed to `UIActivityViewController`, which is what the system
    /// turns into the extension's `NSExtensionItem` providers.
    func activityItems() -> [Any] {
        switch self {
        case .text:
            [ShareExtensionUITestHost.sharedText]
        case .url:
            [ShareExtensionUITestHost.sharedURL]
        case .attachments:
            [
                ShareExtensionUITestHost.sharedText,
                ShareExtensionUITestHost.sharedURL,
                Self.imageFile(),
                Self.pdfFile(),
                Self.dataFile()
            ]
        case .unsupported:
            // Two web URLs exceed NSExtensionActivationSupportsWebURLWithMaxCount, so the
            // system must not offer Talaria at all.
            [ShareExtensionUITestHost.sharedURL, URL(string: "https://share.fixture.invalid/second")!]
        case .oversizedFile:
            [Self.file(named: "fixture-oversized.dat", byteCount: 25 * 1_024 * 1_024)]
        case .oversizedTotal:
            [
                Self.file(named: "fixture-half-a.dat", byteCount: 12 * 1_024 * 1_024),
                Self.file(named: "fixture-half-b.dat", byteCount: 12 * 1_024 * 1_024)
            ]
        }
    }

    static let imageFileName = "fixture-image.png"
    static let pdfFileName = "fixture-document.pdf"
    static let dataFileName = "fixture-file.dat"

    private static func imageFile() -> URL {
        let size = CGSize(width: 24, height: 24)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        return write(image.pngData() ?? Data(), to: imageFileName)
    }

    private static func pdfFile() -> URL {
        let bounds = CGRect(x: 0, y: 0, width: 120, height: 120)
        let data = UIGraphicsPDFRenderer(bounds: bounds).pdfData { context in
            context.beginPage()
            UIColor.black.setStroke()
            UIBezierPath(rect: bounds.insetBy(dx: 10, dy: 10)).stroke()
        }
        return write(data, to: pdfFileName)
    }

    private static func dataFile() -> URL {
        write(Data(ShareExtensionUITestHost.sharedText.utf8), to: dataFileName)
    }

    private static func file(named name: String, byteCount: Int) -> URL {
        write(Data(count: byteCount), to: name)
    }

    private static func write(_ data: Data, to name: String) -> URL {
        let url = ShareExtensionUITestHost.payloadDirectory.appendingPathComponent(name)
        try? data.write(to: url, options: .atomic)
        return url
    }
}

/// Compact overlay bar: one button per payload plus the fallback switch. It stays out of
/// the composer's way so the same launch can both share and verify the import.
struct ShareExtensionUITestHostBar: View {
    @State private var presentedPayload: ShareExtensionUITestPayload?
    @State private var openMode = ShareOpenFixtureMode.normal

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
            ForEach(ShareExtensionUITestPayload.allCases) { payload in
                Button(payload.title) { presentedPayload = payload }
                    .accessibilityIdentifier(payload.accessibilityIdentifier)
            }

            Button("WA") { openMode = .workaround }
                .accessibilityIdentifier("share-host-open-mode-workaround")
            Button("Man") { openMode = .manualOnly }
                .accessibilityIdentifier("share-host-open-mode-manual")
        }
        .font(.caption)
        .buttonStyle(.bordered)
        .padding(4)
        .background(.regularMaterial)
        .accessibilityIdentifier("share-host-bar")
        .onChange(of: openMode, initial: true) { ShareOpenFixtureMode.store(openMode) }
        .sheet(item: $presentedPayload) { payload in
            ShareExtensionUITestActivitySheet(activityItems: payload.activityItems())
                .ignoresSafeArea()
        }
    }
}

private struct ShareExtensionUITestActivitySheet: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif
