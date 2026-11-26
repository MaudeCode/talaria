import os
import XCTest
@testable import TalariaKit

final class ScreenSessionTests: XCTestCase {
    @MainActor
    func testTakeOverHandBackAndDismissUseTheOpenViewersLease() async throws {
        let frameRequested = expectation(description: "RFB client requested an incremental update after painting")
        let socket = ScreenTestSocket(frameRequested: frameRequested)
        let service = ScreenTestService(socket: socket)
        let viewer = ScreenSession(service: service, sessionID: "screen-chat")
        let watch = Task { await viewer.watch() }
        addTeardownBlock { await viewer.close(); await watch.value }

        await fulfillment(of: [frameRequested], timeout: 10)
        XCTAssertNotNil(viewer.frame)
        XCTAssertFalse(viewer.canSendInput)

        await viewer.changeControl()
        XCTAssertTrue(viewer.canSendInput)
        await viewer.changeControl()
        XCTAssertFalse(viewer.canSendInput)
        await viewer.changeControl()
        XCTAssertTrue(viewer.canSendInput)
        await viewer.close()
        await watch.value

        XCTAssertTrue(socket.closed)
        XCTAssertEqual(service.actions, [.acquire, .release, .acquire, .release])
        XCTAssertEqual(service.leaseViewIDs, Array(repeating: try XCTUnwrap(service.openedViewID), count: 4))
    }

    @MainActor
    func testLostTakeoverAnswerReadsTheLeaseBeforeEnablingInput() async throws {
        let frameRequested = expectation(description: "RFB client requested an incremental update after painting")
        let socket = ScreenTestSocket(frameRequested: frameRequested)
        let service = ScreenTestService(socket: socket, losesAcquireResponse: true)
        let viewer = ScreenSession(service: service, sessionID: "screen-chat")
        let watch = Task { await viewer.watch() }
        addTeardownBlock { await viewer.close(); await watch.value }

        await fulfillment(of: [frameRequested], timeout: 10)
        await viewer.changeControl()
        XCTAssertEqual(service.actions, [.acquire])
        XCTAssertEqual(service.rereadViewID, service.openedViewID)
        XCTAssertTrue(viewer.canSendInput)
    }
}

@MainActor
private final class ScreenTestService: ScreenServing {
    let socket: ScreenTestSocket
    let losesAcquireResponse: Bool
    private(set) var openedViewID: String?
    private(set) var rereadViewID: String?
    private(set) var actions: [ScreenLeaseAction] = []
    private(set) var leaseViewIDs: [String] = []
    private var control: AgentScreen.Control = .agent

    init(socket: ScreenTestSocket, losesAcquireResponse: Bool = false) {
        self.socket = socket
        self.losesAcquireResponse = losesAcquireResponse
    }

    func screen(sessionID: String) async throws -> AgentScreen? {
        AgentScreen(available: true, state: .running, control: .agent, installCommand: nil)
    }

    func openScreen(viewID: String) async throws -> any RFBSocket {
        openedViewID = viewID
        return socket
    }

    func screenView(viewID: String) async throws -> AgentScreen {
        rereadViewID = viewID
        return AgentScreen(available: true, state: .running, control: control, installCommand: nil)
    }

    func screenLease(viewID: String, action: ScreenLeaseAction) async throws -> AgentScreen {
        XCTAssertFalse(socket.closed, "Hand back while the viewer is still registered")
        actions.append(action)
        leaseViewIDs.append(viewID)
        control = action == .acquire ? .you : .agent
        if losesAcquireResponse, action == .acquire { throw APIError.network(underlying: URLError(.networkConnectionLost)) }
        return AgentScreen(available: true, state: .running, control: control, installCommand: nil)
    }
}

private final class ScreenTestSocket: RFBSocket {
    private let frames = OSAllocatedUnfairLock(initialState: [
        Data("RFB 003.008\n".utf8),
        Data([1, 1]),
        Data([0, 0, 0, 0]),
        // 1×1 ServerInit, pixel format and blank desktop name.
        Data([0, 1, 0, 1] + Array(repeating: 0, count: 20)),
        // One Raw rectangle with the green pixel.
        Data([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 255, 0, 0])
    ])
    private let frameRequested: XCTestExpectation
    private let closing = AsyncStream<Void>.makeStream()
    private let didClose = OSAllocatedUnfairLock(initialState: false)
    var closed: Bool { didClose.withLock { $0 } }

    init(frameRequested: XCTestExpectation) {
        self.frameRequested = frameRequested
    }

    func receive() async throws -> Data {
        if let frame = frames.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) { return frame }
        for await _ in closing.stream {}
        throw RFBStreamEnd.closed(code: 1000)
    }

    func send(_ data: Data) async throws {
        if data.starts(with: [3, 1]) { frameRequested.fulfill() }
    }

    func ping() async throws {}

    func close() {
        didClose.withLock { $0 = true }
        closing.continuation.finish()
    }
}
