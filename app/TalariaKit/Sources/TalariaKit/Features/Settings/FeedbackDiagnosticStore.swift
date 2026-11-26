import CryptoKit
import Foundation
#if os(iOS)
import MetricKit
#endif

/// Stores only the fields that can be shared with feedback, never the MetricKit payload.
public final class FeedbackDiagnosticStore: Sendable {
    public static let shared = FeedbackDiagnosticStore(directory: URL.applicationSupportDirectory
        .appending(path: "FeedbackDiagnostics", directoryHint: .isDirectory))

    private static let maximumCount = 10
    private static let maximumAge: TimeInterval = 14 * 86_400
    private static let maximumBytes = 2 * 1_024 * 1_024

    private let directory: URL
    private let lock = NSLock()

    init(directory: URL) {
        self.directory = directory
    }

    struct Entry {
        let id: String
        let report: FeedbackDiagnosticReport
        let end: Date
        let data: Data
    }

    func recent(now: Date = .now) -> [Entry] {
        lock.withLock { retain([], now: now) }
    }

    func record(_ reports: [FeedbackDiagnosticReport], now: Date = .now) {
        lock.withLock { _ = retain(reports, now: now) }
    }

    private func retain(_ reports: [FeedbackDiagnosticReport], now: Date) -> [Entry] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        var entries: [String: Entry] = [:]
        let cutoff = now.addingTimeInterval(-Self.maximumAge)
        let decoder = JSONDecoder()
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file) else { continue }
            guard let report = try? decoder.decode(FeedbackDiagnosticReport.self, from: data),
                  let end = try? Date.ISO8601FormatStyle().parse(report.end), end >= cutoff else {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            let id = file.deletingPathExtension().lastPathComponent
            entries[id] = Entry(id: id, report: report, end: end, data: data)
        }

        let existingIDs = Set(entries.keys)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        for report in reports {
            guard let end = try? Date.ISO8601FormatStyle().parse(report.end), end >= cutoff,
                  let data = try? encoder.encode(report), data.count + 2 <= Self.maximumBytes else { continue }
            let id = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            entries[id] = Entry(id: id, report: report, end: end, data: data)
        }

        let ordered = entries.values.sorted {
            $0.end == $1.end ? $0.id < $1.id : $0.end > $1.end
        }
        // Include the JSON array brackets and separators in the wire budget.
        var bytes = 1
        var retained: [Entry] = []
        for entry in ordered.prefix(Self.maximumCount) {
            bytes += entry.data.count + 1
            guard bytes <= Self.maximumBytes else { break }
            retained.append(entry)
        }
        let keptIDs = Set(retained.map(\.id))
        for id in existingIDs.subtracting(keptIDs) {
            try? FileManager.default.removeItem(at: reportURL(id))
        }

        return retained.filter { entry in
            existingIDs.contains(entry.id) || write(entry)
        }
    }

    private func reportURL(_ id: String) -> URL {
        directory.appending(path: "\(id).json")
    }

    private func write(_ entry: Entry) -> Bool {
        do {
            var directory = directory
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            #if os(iOS)
            try entry.data.write(to: reportURL(entry.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try entry.data.write(to: reportURL(entry.id), options: .atomic)
            #endif
            return true
        } catch {
            return false
        }
    }
}

extension FeedbackDiagnosticReport {
    /// Allowlist from Apple's MXCallStackTree JSON format. UUID and text offset suffice for symbolication.
    static func project(kind: Kind, start: Date, end: Date, build: String, stackTree: Data) -> Self {
        let document = (try? JSONSerialization.jsonObject(with: stackTree)) as? [String: Any]
        let tree = document?["callStackTree"] as? [String: Any]
        let stacks = tree?["callStacks"] as? [[String: Any]] ?? []
        let attributed = stacks.filter { $0["threadAttributed"] as? Bool == true }
        let roots = (attributed + stacks.filter { $0["threadAttributed"] as? Bool != true })
            .flatMap { $0["callStackRootFrames"] as? [[String: Any]] ?? [] }
        var pending = Array(roots.reversed())
        var frames: [String] = []
        while frames.count < 8_192, let frame = pending.popLast() {
            if let rawUUID = frame["binaryUUID"] as? String, let uuid = UUID(uuidString: rawUUID),
               let offset = frame["offsetIntoBinaryTextSegment"] as? UInt64 {
                frames.append("\(uuid.uuidString) + \(offset)")
            }
            if let children = frame["subFrames"] as? [[String: Any]] {
                pending.append(contentsOf: children.reversed())
            }
        }
        let safeBuild = !build.isEmpty && build.utf8.count <= 64
            && build.utf8.allSatisfy { $0 == 46 || (48...57).contains($0) }
        return Self(kind: kind, start: start.ISO8601Format(), end: end.ISO8601Format(),
                    build: safeBuild ? build : "unknown", frames: frames)
    }
}

#if os(iOS)
extension FeedbackDiagnosticStore {
    @MainActor
    public static func startCollection() {
        MXMetricManager.shared.add(MetricKitSubscriber.shared)
        Task.detached(priority: .utility) { _ = shared.recent() }
    }
}

private final class MetricKitSubscriber: NSObject, MXMetricManagerSubscriber, Sendable {
    static let shared = MetricKitSubscriber()

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            func project(_ diagnostic: MXDiagnostic, kind: FeedbackDiagnosticReport.Kind, stack: MXCallStackTree) -> FeedbackDiagnosticReport {
                .project(kind: kind, start: payload.timeStampBegin, end: payload.timeStampEnd,
                         build: diagnostic.metaData.applicationBuildVersion, stackTree: stack.jsonRepresentation())
            }
            let reports = (payload.crashDiagnostics ?? []).map { project($0, kind: .crash, stack: $0.callStackTree) }
                + (payload.hangDiagnostics ?? []).map { project($0, kind: .hang, stack: $0.callStackTree) }
                + (payload.cpuExceptionDiagnostics ?? []).map { project($0, kind: .cpuException, stack: $0.callStackTree) }
                + (payload.diskWriteExceptionDiagnostics ?? []).map { project($0, kind: .diskWrite, stack: $0.callStackTree) }
            FeedbackDiagnosticStore.shared.record(reports)
        }
    }
}
#endif
