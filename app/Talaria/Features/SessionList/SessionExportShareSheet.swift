import SwiftUI
import UIKit

struct SessionExportShareSheet: UIViewControllerRepresentable {
    let fileURL: URL

    func makeCoordinator() -> URL { fileURL }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: UIActivityViewController, coordinator: URL) {
        // Each exporter owns the file's temporary directory until the share sheet is dismissed.
        try? FileManager.default.removeItem(at: coordinator.deletingLastPathComponent())
    }
}
