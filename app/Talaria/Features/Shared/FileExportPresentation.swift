import SwiftUI
import TalariaKit

extension View {
    /// Presents the system file exporter while `payload` is set and clears it on dismissal. A failed
    /// write lands in `errorMessage`, which also shows the caller's own failures under `errorTitle`.
    func fileExporter(
        payload: Binding<FileExportPayload?>,
        errorTitle: LocalizedStringKey,
        errorMessage: Binding<String?>
    ) -> some View {
        fileExporter(
            isPresented: Binding(
                get: { payload.wrappedValue != nil },
                set: { if !$0 { payload.wrappedValue = nil } }
            ),
            document: payload.wrappedValue.map { ExportedFileDocument(data: $0.data) },
            contentType: payload.wrappedValue?.contentType ?? .data,
            defaultFilename: payload.wrappedValue?.filename
        ) { result in
            if case let .failure(error) = result {
                errorMessage.wrappedValue = error.localizedDescription
            }
        }
        .messageAlert(errorTitle, message: errorMessage)
    }

    /// An OK-only alert shown while `message` is set.
    func messageAlert(_ title: LocalizedStringKey, message: Binding<String?>) -> some View {
        alert(
            title,
            isPresented: Binding(
                get: { message.wrappedValue != nil },
                set: { if !$0 { message.wrappedValue = nil } }
            )
        ) {
            Button("OK") {
                message.wrappedValue = nil
            }
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}
