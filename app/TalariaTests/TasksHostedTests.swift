import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The Tasks list's TAL-810 fields (TAL-835): the unwritable-store banner and a job row's last failure.
@MainActor
final class TasksHostedTests: XCTestCase {
    func testStoreBannerShowsOnlyForAnUnwritableStore() throws {
        let stores = try decode([CronStoreHealth].self, """
        [{"profile": "work", "store": "/synthetic/work/cron", "error": "No space left on device",
          "fix": "Free disk space on the store's volume.", "since": null}]
        """)
        let window = try hostWindow(CronStoreHealthBanner(stores: stores))
        let labels = HostedAccessibility.labels(in: window)
        XCTAssertEqual(labels.count, 1, "\(labels)")
        XCTAssertTrue(labels.first?.hasPrefix("Scheduled tasks can't run") == true, "\(labels)")
        XCTAssertTrue(labels.first?.contains("work: No space left on device") == true, "\(labels)")
        XCTAssertTrue(labels.first?.contains("Free disk space on the store's volume.") == true, "\(labels)")

        let healthy = try hostWindow(CronStoreHealthBanner(stores: []))
        XCTAssertEqual(HostedAccessibility.labels(in: healthy), [])
    }

    func testJobRowKeepsItsLastFailureAfterALaterSuccess() throws {
        let job = try decode(CronJob.self, """
        {"id": "job-a", "name": "Digest", "schedule_display": "0 7 * * *", "schedule_input": "0 7 * * *",
         "last_status": "ok", "derived_state": "active",
         "last_failure": {"at": null, "detail": "Provider timed out"}}
        """)
        let window = try hostWindow(CronJobRowView(job: job, isRunning: false, runningElapsed: nil))
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        XCTAssertTrue(labels.contains("Failed, Provider timed out"), labels)
    }

    func testJobRunningElsewhereReadsAsRunning() throws {
        let job = try decode(CronJob.self, #"{"id": "job-a", "name": "Digest", "derived_state": "active"}"#)
        let window = try hostWindow(CronJobRowView(job: job, isRunning: true, runningElapsed: nil))
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        XCTAssertTrue(labels.contains("Running"), labels)
        XCTAssertFalse(labels.contains("Elapsed"), "Another process's run has no elapsed time here: \(labels)")
    }

    /// The Tasks list loaded from the fixture server: the store banner, the recovered job's failure and the job another
    /// process runs, counted as running.
    func testTasksListRendersTheServersStoreHealthFailureAndRunElsewhere() async throws {
        let window = try hostWindow(tasksList(try FixtureApp([UITestFixtureEnvironment.unwritableCronStoreArgument], for: self)))

        let banner = try await requireElement(in: window, "No store banner") {
            $0.accessibilityLabel?.hasPrefix("Scheduled tasks can't run") == true
        }
        XCTAssertTrue(banner.accessibilityLabel?.contains("default: [Errno 28] No space left on device") == true)
        _ = try await requireElement(in: window, "The recovered job lost its last failure") {
            $0.accessibilityLabel.map { $0.contains("Failed, ") && $0.contains(" · Provider timed out after 120s") } == true
        }
        _ = try await requireElement(in: window, "The job another process runs is not shown running") {
            $0.accessibilityLabel?.hasPrefix("Morning digest, Running") == true
        }
        _ = try await requireElement(in: window, "The running count leaves out the run elsewhere") {
            $0.accessibilityLabel == "Scheduled Jobs, 1 running"
        }
    }

    func testTasksListWithoutStoreHealthShowsNoBanner() async throws {
        let window = try hostWindow(tasksList(try FixtureApp(for: self)))

        _ = try await requireElement(in: window, label: "No Tasks")
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains { $0.hasPrefix("Scheduled tasks can't run") })
    }

    /// Run Now on a job another process runs shows the server's `already_running` answer.
    func testRunNowOnAJobRunningElsewhereSaysItIsAlreadyRunning() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.unwritableCronStoreArgument], for: self)
        let jobs = try await fixture.client.crons().jobs ?? []
        let job = try XCTUnwrap(jobs.first { $0.jobId == UITestFixtureURLProtocol.cronRunningElsewhereJobID })
        let viewModel = TaskDetailViewModel(job: job, runningElapsed: nil, isRunning: true, server: UITestFixtureEnvironment.serverURL)
        XCTAssertTrue(viewModel.isRunning)

        let didRun = await viewModel.runNow()

        XCTAssertFalse(didRun)
        XCTAssertEqual(viewModel.actionErrorMessage, "This task is already running.")
        XCTAssertTrue(viewModel.isRunning)
    }

    private func tasksList(_ fixture: FixtureApp) -> some View {
        NavigationStack {
            TasksView(
                viewModel: TasksViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client),
                selection: .constant(nil),
                onAPIError: { _ in }
            )
        }
    }

    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(type, from: Data(json.utf8))
    }
}

/// Button-started reads live and die with their screen, as `.task` reads do (TAL-205).
@MainActor
final class ScreenReadsHostedTests: XCTestCase {
    func testLeavingTheScreenCancelsItsSuspendedRead() throws {
        let reads = ScreenReads()
        let screen = ShownScreen()
        _ = try hostWindow(ShownScreenHost(screen: screen, reads: reads))
        let request = HeldRequest()
        let landed = ReadLog()
        reads.start {
            do { try await request.response(); landed.entries.append("answered") } catch { landed.entries.append("cancelled") }
        }
        settle()
        XCTAssertEqual(landed.entries, [], "The request is still held")

        screen.isShown = false
        XCTAssertTrue(waitUntil { !landed.entries.isEmpty }, "Leaving the screen left its read running")
        XCTAssertEqual(landed.entries, ["cancelled"])
        request.answer()
    }

    func testANewerReadLandsAfterTheOlderOneItSupersedes() throws {
        let reads = ScreenReads()
        _ = try hostWindow(ShownScreenHost(screen: ShownScreen(), reads: reads))
        let older = HeldRequest()
        let landed = ReadLog()
        reads.start {
            // The older response is already on its way: it arrives despite the cancellation.
            try? await older.response(cancellable: false)
            landed.entries.append(Task.isCancelled ? "older, cancelled" : "older")
        }
        settle()
        reads.start { landed.entries.append("newer") }
        settle()
        older.answer()

        XCTAssertTrue(waitUntil { landed.entries.count == 2 }, "Both reads finish: \(landed.entries)")
        XCTAssertEqual(landed.entries, ["older, cancelled", "newer"], "The newer read must cancel the older one and land last")
    }
}

@MainActor
private final class ReadLog {
    var entries: [String] = []
}

@MainActor @Observable
private final class ShownScreen {
    var isShown = true
}

private struct ShownScreenHost: View {
    let screen: ShownScreen
    let reads: ScreenReads

    var body: some View {
        if screen.isShown {
            Color.clear.ownsReads(reads)
        }
    }
}

/// A request held until `answer()`. A cancellable one throws as soon as its caller is cancelled, as URLSession's do.
@MainActor
private final class HeldRequest {
    private var continuation: CheckedContinuation<Void, Error>?

    func response(cancellable: Bool = true) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation = $0 }
        } onCancel: {
            guard cancellable else { return }
            Task { @MainActor in self.finish(.failure(CancellationError())) }
        }
    }

    func answer() {
        finish(.success(()))
    }

    private func finish(_ result: Result<Void, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}
