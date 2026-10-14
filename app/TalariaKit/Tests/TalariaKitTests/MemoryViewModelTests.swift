import XCTest
@testable import TalariaKit

final class MemoryViewModelTests: APIClientTestCase {
    @MainActor
    func testSaveWritesSelectedSectionAndReloadsMemory() async throws {
        var requestPaths: [String] = []
        let client = makeClient { request in
            requestPaths.append(request.url?.path ?? "")

            if request.url?.path == "/api/memory/write" {
                XCTAssertEqual(request.httpMethod, "POST")
                let data = try XCTUnwrap(apiTestBodyData(from: request))
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["section"] as? String, "soul")
                XCTAssertEqual(body?["content"] as? String, "# Updated Soul")

                return apiTestJSONResponse("""
                {
                  "ok": true,
                  "section": "soul",
                  "path": "/Users/test/.hermes/SOUL.md"
                }
                """, for: request)
            }

            XCTAssertEqual(request.url?.path, "/api/memory")
            return apiTestJSONResponse("""
            {
              "memory": "# Notes",
              "user": "# Profile",
              "soul": "# Updated Soul",
              "memory_mtime": 1770000000,
              "user_mtime": 1770000100,
              "soul_mtime": 1770000200
            }
            """, for: request)
        }
        let viewModel = MemoryViewModel(
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        let didSave = await viewModel.save(section: .soul, content: "# Updated Soul")

        XCTAssertTrue(didSave)
        XCTAssertEqual(requestPaths, ["/api/memory/write", "/api/memory"])
        XCTAssertEqual(viewModel.memoryText, "# Notes")
        XCTAssertEqual(viewModel.userText, "# Profile")
        XCTAssertEqual(viewModel.soulText, "# Updated Soul")
        XCTAssertEqual(viewModel.soulMtime, Date(timeIntervalSince1970: 1_770_000_200))
        XCTAssertTrue(viewModel.hasLoaded)
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    @MainActor
    func testSaveSendsTheLoadedRevisionAndOffersAReloadOnConflict() async throws {
        var requestPaths: [String] = []
        let client = makeClient { request in
            requestPaths.append(request.url?.path ?? "")
            if request.url?.path == "/api/memory/write" {
                let data = try XCTUnwrap(apiTestBodyData(from: request))
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["section"] as? String, "memory")
                XCTAssertEqual(body?["revision"] as? String, "rev-memory")
                return apiTestJSONResponse("""
                {
                  "error": "MEMORY.md changed after you opened it. Not saved.",
                  "code": "memory_conflict"
                }
                """, statusCode: 409, for: request)
            }
            return apiTestJSONResponse("""
            {
              "memory": "Entry A",
              "user": "",
              "soul": "",
              "memory_revision": "rev-memory",
              "user_revision": "rev-user",
              "soul_revision": "rev-soul"
            }
            """, for: request)
        }
        let viewModel = MemoryViewModel(
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()
        let didSave = await viewModel.save(section: .memory, content: "Entry A\n§\nEntry C")

        XCTAssertFalse(didSave)
        XCTAssertEqual(requestPaths, ["/api/memory", "/api/memory/write"])
        XCTAssertEqual(viewModel.actionErrorMessage, "MEMORY.md changed after you opened it. Not saved.")
        XCTAssertTrue(viewModel.hasSaveConflict)
        XCTAssertNil(viewModel.lastError)
        XCTAssertEqual(viewModel.memoryText, "Entry A")

        await viewModel.reloadAfterConflict()

        XCTAssertFalse(viewModel.hasSaveConflict)
        XCTAssertNil(viewModel.actionErrorMessage)
        XCTAssertEqual(requestPaths, ["/api/memory", "/api/memory/write", "/api/memory"])
    }

    @MainActor
    func testSaveSurfacesRejectedResponseWithoutReloading() async throws {
        var requestPaths: [String] = []
        let client = makeClient { request in
            requestPaths.append(request.url?.path ?? "")

            return apiTestJSONResponse("""
            {
              "ok": false,
              "error": "section rejected"
            }
            """, for: request)
        }
        let viewModel = MemoryViewModel(
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        let didSave = await viewModel.save(section: .memory, content: "# Notes")

        XCTAssertFalse(didSave)
        XCTAssertEqual(requestPaths, ["/api/memory/write"])
        XCTAssertEqual(viewModel.actionErrorMessage, "section rejected")
        XCTAssertFalse(viewModel.hasLoaded)
    }

    @MainActor
    func testLoadSurfacesProjectContextDocument() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/memory")

            return apiTestJSONResponse("""
            {
              "memory": "# Notes",
              "user": "# Profile",
              "soul": "# Soul",
              "project_context": "# Project rules",
              "project_context_name": "AGENTS.md",
              "project_context_workspace": "/Users/test/workspace",
              "project_context_mtime": 1770000300,
              "project_context_shadowed": [
                {
                  "name": "PROJECT.md",
                  "path": "/Users/test/PROJECT.md"
                }
              ],
              "external_notes_enabled": true
            }
            """, for: request)
        }
        let viewModel = MemoryViewModel(
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()

        XCTAssertTrue(viewModel.showsProjectContext)
        XCTAssertEqual(viewModel.projectContextText, "# Project rules")
        XCTAssertEqual(viewModel.projectContextName, "AGENTS.md")
        XCTAssertEqual(viewModel.projectContextWorkspace, "/Users/test/workspace")
        XCTAssertEqual(viewModel.projectContextMtime, Date(timeIntervalSince1970: 1_770_000_300))
        XCTAssertTrue(viewModel.isProjectContextShadowed)
        XCTAssertEqual(viewModel.isExternalNotesEnabled, true)
        XCTAssertEqual(viewModel.projectContextDetail, "AGENTS.md — /Users/test/workspace")
    }

    @MainActor
    func testProjectContextSectionHiddenWithoutFields() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/memory")

            return apiTestJSONResponse("""
            {
              "memory": "# Notes",
              "user": "# Profile",
              "soul": "# Soul"
            }
            """, for: request)
        }
        let viewModel = MemoryViewModel(
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()

        XCTAssertTrue(viewModel.hasLoaded)
        XCTAssertFalse(viewModel.showsProjectContext)
        XCTAssertFalse(viewModel.isProjectContextShadowed)
        XCTAssertNil(viewModel.projectContextDetail)
        XCTAssertNil(viewModel.isExternalNotesEnabled)
    }

    @MainActor
    func testProjectContextSectionHiddenForBlankDocumentAndDetailOmitsEmptyParts() async throws {
        // Upstream returns "" (not null) when no readable project-context file exists.
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/memory")

            return apiTestJSONResponse("""
            {
              "memory": "# Notes",
              "project_context": "  \\n ",
              "project_context_name": "",
              "project_context_workspace": "/Users/test/workspace",
              "project_context_shadowed": []
            }
            """, for: request)
        }
        let viewModel = MemoryViewModel(
            server: try XCTUnwrap(URL(string: "https://example.test")),
            client: client
        )

        await viewModel.load()

        XCTAssertFalse(viewModel.showsProjectContext)
        XCTAssertFalse(viewModel.isProjectContextShadowed)
        XCTAssertEqual(viewModel.projectContextDetail, "/Users/test/workspace")
    }
}
