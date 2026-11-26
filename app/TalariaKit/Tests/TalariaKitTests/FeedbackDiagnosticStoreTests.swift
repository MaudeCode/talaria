import XCTest
@testable import TalariaKit

final class FeedbackDiagnosticStoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_795_000_000)

    func testProjectsOnlySymbolicationDataFromAnAppleStackTree() throws {
        // Apple's MXCallStackTree.jsonRepresentation example shape, with synthetic private fields.
        let tree = Data("""
        {
          "exceptionReason": "private exception",
          "deviceType": "private device",
          "callStackTree": {
            "callStacks": [
              {"threadAttributed": false, "callStackRootFrames": [
                {"binaryUUID": "private path", "offsetIntoBinaryTextSegment": 99}
              ]},
              {"threadAttributed": true, "callStackRootFrames": [{
                "binaryName": "/private/path/App", "address": 7170766264,
                "binaryUUID": "70B89F27-1634-3580-A695-57CDB41D7743", "offsetIntoBinaryTextSegment": 165304,
                "subFrames": [{"binaryName": "libdyld.dylib",
                  "binaryUUID": "77A62F2E-8212-30F3-84C1-E8497440ACF8", "offsetIntoBinaryTextSegment": 6948}]
              }]}
            ]
          }
        }
        """.utf8)
        let report = FeedbackDiagnosticReport.project(kind: .crash, start: now - 60, end: now, build: "42", stackTree: tree)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? NSDictionary)
        XCTAssertEqual(json, [
            "kind": "crash", "start": (now - 60).ISO8601Format(), "end": now.ISO8601Format(), "build": "42",
            "frames": ["70B89F27-1634-3580-A695-57CDB41D7743 + 165304", "77A62F2E-8212-30F3-84C1-E8497440ACF8 + 6948"],
        ] as NSDictionary)
    }

    func testRepeatedReportsUseOneFileAcrossStoreInstances() throws {
        let (store, directory) = makeStore()
        let report = report(at: now)
        store.record([report, report], now: now)
        let reopened = FeedbackDiagnosticStore(directory: directory)
        reopened.record([report], now: now)
        XCTAssertEqual(reopened.recent(now: now).map(\.report), [report])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
    }

    func testKeepsOnlyTheNewestTenReports() throws {
        let (store, directory) = makeStore()
        let reports = (0..<12).map { report(at: now - Double($0)) }
        store.record(reports.reversed(), now: now)
        XCTAssertEqual(store.recent(now: now).map(\.report), Array(reports.prefix(10)))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 10)
    }

    func testReadingPurgesReportsPastRetention() throws {
        let (store, directory) = makeStore()
        let report = report(at: now)
        store.record([report], now: now)
        let boundary = now + 14 * 86_400
        XCTAssertEqual(store.recent(now: boundary).map(\.report), [report])
        XCTAssertTrue(store.recent(now: boundary + 1).isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testRetentionReservesSpaceForTheWireArray() throws {
        let (store, directory) = makeStore()
        let base = report(at: now, frame: "")
        let cap = 2 * 1_024 * 1_024
        let overhead = try JSONEncoder().encode(base).count
        let size = cap / 2 - overhead
        let reports = [report(at: now, frame: String(repeating: "a", count: size)),
                       report(at: now - 1, frame: String(repeating: "b", count: size))]
        XCTAssertEqual(try reports.map { try JSONEncoder().encode($0).count }.reduce(0, +), cap)
        XCTAssertGreaterThan(try JSONEncoder().encode(reports).count, cap)
        store.record(reports.reversed(), now: now)
        XCTAssertEqual(store.recent(now: now).map(\.report.end), [reports[0].end])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
    }

    private func report(at date: Date, frame: String = "UUID + 128") -> FeedbackDiagnosticReport {
        .init(kind: .hang, start: (date - 60).ISO8601Format(), end: date.ISO8601Format(), build: "42", frames: [frame])
    }

    private func makeStore() -> (FeedbackDiagnosticStore, URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return (FeedbackDiagnosticStore(directory: directory), directory)
    }
}
